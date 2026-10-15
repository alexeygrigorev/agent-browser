const status = document.querySelector('#status');
async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'status' });
  status.textContent = state.status;
  const name = document.querySelector('#browser-name');
  name.textContent = state.browser?.name ? `Browser: ${state.browser.name}` : '';
  name.hidden = !state.browser?.name;
  document.querySelector('#disconnect').disabled = !state.enabled;
  document.querySelector('#connect').disabled = state.enabled;
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
