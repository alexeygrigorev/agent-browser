function diagnostic(code, message, action) {
  return { code, message, ...(action ? { action } : {}) };
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Inspect one profile without changing profiles, permissions, or browser state. */
export async function doctorBrowser(client, options = {}) {
  return connectBrowser(client, { ...options, reload: false });
}

/** Start through the client's normal readiness path and select exactly one profile. */
export async function connectBrowser(client, options = {}) {
  if (!client || typeof client.call !== 'function') throw new Error('A browser client is required');
  const requested = options.profile ?? options.browser;
  if (requested !== undefined && (typeof requested !== 'string' || !requested.trim())) throw new Error('Profile must be a non-empty nickname or ID');
  const result = { ready: false, profile: null, extension: null, bridge: null, reloaded: false, diagnostics: [] };
  const fail = (code, text, action) => {
    result.diagnostics.push(diagnostic(code, text, action));
    return result;
  };
  let profiles;
  try { profiles = await client.call('browsers.list'); }
  catch (error) {
    return fail('bridge_unavailable', message(error), 'Check the bridge endpoint and access approval; open Chrome with the extension enabled and not paused.');
  }
  if (!Array.isArray(profiles)) return fail('invalid_response', 'The bridge returned an invalid profile list.', 'Update and restart the browser bridge.');
  let connected = profiles.filter(profile => profile?.connected === true);
  let profile = requested === undefined
    ? connected.length === 1 ? connected[0] : undefined
    : profiles.find(profile => profile?.id === requested || (typeof profile?.name === 'string' && profile.name.toLowerCase() === requested.toLowerCase()));
  // Starting/restarting the bridge can precede the extension's reconnect by a
  // few seconds. Use the normal bounded readiness wait instead of diagnosing a
  // still-reconnecting Chrome as closed. Doctor remains an immediate read.
  if (options.reload !== false && (profile?.connected === false || connected.length === 0)) {
    try {
      await client.call('browser.info', {}, requested === undefined ? {} : { browser: profile?.id || requested });
      profiles = await client.call('browsers.list');
      if (!Array.isArray(profiles)) throw new Error('Invalid profile list');
      connected = profiles.filter(item => item?.connected === true);
      profile = requested === undefined
        ? connected.length === 1 ? connected[0] : undefined
        : profiles.find(item => item?.id === requested || item?.name?.toLowerCase() === requested.toLowerCase());
    } catch { /* Retain the specific disconnected/ambiguous diagnostic below. */ }
  }
  if (!profile) {
    if (requested !== undefined) return fail('profile_not_found', `Profile is not connected: ${requested}.`, 'Open this Chrome profile and check its extension; no other profile was selected.');
    if (connected.length > 1) return fail('profile_ambiguous', 'Multiple profiles are connected; select a nickname or ID.', `Connected profiles: ${connected.map(profile => profile.name || profile.id).join(', ')}.`);
    return fail('extension_disconnected', 'No browser profile is connected.', 'Open Chrome and enable the extension. If it is paused, resume it in the extension popup.');
  }
  result.profile = { id: profile.id, name: profile.name ?? null, connected: profile.connected === true };
  if (!profile.connected) return fail('profile_disconnected', `Profile is not connected: ${requested}.`, 'Open this Chrome profile and check that its extension is enabled and not paused.');
  if (typeof profile.id !== 'string' || !profile.id) return fail('invalid_response', 'The selected profile has no browser ID.', 'Update and restart the browser bridge.');
  // Pin every later operation to the ID that was selected, even if names change.
  const callOptions = { browser: profile.id };
  let info;
  try { info = await client.call('extension.info', {}, callOptions); }
  catch (error) { return fail('extension_unavailable', message(error), 'Update the bridge and reload the extension in chrome://extensions if this command is unsupported.'); }
  result.extension = info?.extension ?? null;
  result.bridge = info?.bridge ?? null;
  if (!result.extension || typeof result.extension !== 'object' || !result.bridge || typeof result.bridge !== 'object') return fail('invalid_response', 'The bridge returned incomplete extension diagnostics.', 'Update and restart the bridge, then reload the extension.');
  if (result.bridge.restartNeeded) return fail('bridge_restart_needed', 'The running bridge predates this checkout.', 'Restart the browser bridge or desktop daemon when its current tasks have finished, then reconnect.');
  if (result.extension.current !== true) {
    const canReload = options.reload !== false && info?.capabilities?.safeReload === true;
    if (canReload) {
      try {
        const updated = await client.call('extension.reload', { onlyIfIdle: true }, callOptions);
        if (updated?.browser?.id !== profile.id) return fail('invalid_response', 'The reload response did not confirm the selected profile.', 'Reconnect to the selected profile and inspect its extension version.');
        result.extension = updated.extension ?? null;
        result.bridge = updated.bridge ?? null;
        result.reloaded = updated.reloaded === true;
      } catch (error) { return fail('extension_reload_failed', message(error), 'Let current browser tasks finish; if the extension is too old, reload it once in chrome://extensions.'); }
      if (result.bridge?.restartNeeded) return fail('bridge_restart_needed', 'The running bridge predates this checkout.', 'Restart the browser bridge or desktop daemon when its current tasks have finished, then reconnect.');
    }
    if (result.extension?.current !== true) {
      return fail('extension_outdated', 'The running extension does not match this checkout, or its version cannot be verified.', 'Finish current browser tasks and reload the extension in chrome://extensions; update the bridge to enable safe automatic reloads.');
    }
  }
  result.ready = true;
  return result;
}
