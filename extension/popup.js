const token = document.querySelector('#token');
const status = document.querySelector('#status');
async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'status' });
  status.textContent = state.status;
  document.querySelector('#disconnect').disabled = !state.enabled;
}
document.querySelector('#connect').addEventListener('click', async () => {
  if (token.value.trim().length < 32) { status.textContent = 'Enter a token of at least 32 characters.'; return; }
  await chrome.runtime.sendMessage({ type: 'connect', token: token.value.trim() });
  token.value = '';
  await refresh();
});
document.querySelector('#disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  await refresh();
});
await refresh();
setInterval(refresh, 1000);
