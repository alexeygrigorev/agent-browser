const status = document.querySelector('#status');
const background = document.querySelector('#background');
const backgroundPermission = { permissions: ['background'] };
// Request synchronously within the checkbox's user gesture. Never enable this
// permission as a side effect of connecting, reconnecting, or resuming access.
background.addEventListener('change', async () => {
  background.disabled = true;
  try {
    if (background.checked) await chrome.permissions.request(backgroundPermission);
    else await chrome.permissions.remove(backgroundPermission);
  } catch (error) {
    status.textContent = error.message;
  } finally {
    background.checked = await chrome.permissions.contains(backgroundPermission);
    background.disabled = false;
  }
});
async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'status' });
  status.textContent = state.status;
  const name = document.querySelector('#browser-name');
  name.textContent = state.browser?.name ? `Browser: ${state.browser.name}` : '';
  name.hidden = !state.browser?.name;
  document.querySelector('#disconnect').disabled = !state.enabled;
  document.querySelector('#connect').disabled = state.enabled;
  if (!background.disabled) background.checked = await chrome.permissions.contains(backgroundPermission);
}
document.querySelector('#connect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'connect' });
  await refresh();
});
document.querySelector('#disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  await refresh();
});
await refresh();
setInterval(refresh, 1000);
