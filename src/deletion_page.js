export function deletionPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Delete account — ARROW: THE LAST LANTERN</title></head><body>
<main><h1>ARROW: THE LAST LANTERN</h1><h2>Delete your game account</h2>
<p>This permanently removes your linked game save, levels, hints, coins, unlocks and login connection from our live database. Unspent purchased coins are forfeited. Deletion does not refund a payment; contact Apple or Google Play for refund requests.</p>
<p>Only irreversible transaction fingerprints remain to prevent previously credited purchases being credited again. Backups, if enabled by the operator, expire according to the published privacy policy.</p>
<p>Android players: sign in with the same Google account used in the game. You do not need to reinstall the app. iPhone and guest players can use Account &amp; cloud save → Delete account in the game. Unlinked guest progress exists only on its original phone.</p>
<label><input id="confirm" type="checkbox"> I understand this is permanent and want to delete my game account.</label>
<button id="start" type="button">Verify my Google account</button><div id="google"></div><p id="status" role="status"></p>
<script src="https://accounts.google.com/gsi/client" defer></script><script src="/delete-account.js" defer></script>
</main></body></html>`;
}
deletionPage.script = `
const status = document.querySelector('#status');
async function call(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to complete deletion. Please retry online.');
  return response.json();
}
document.querySelector('#start').addEventListener('click', async () => {
  if (!document.querySelector('#confirm').checked) { status.textContent = 'Please read and confirm the deletion warning first.'; return; }
  document.querySelector('#start').disabled = true;
  try {
    const challenge = await call('/v1/public-deletion/challenge', {});
    google.accounts.id.initialize({ client_id: challenge.clientId, nonce: challenge.nonce, auto_select: false,
      callback: async ({ credential }) => {
        try {
          if (!document.querySelector('#confirm').checked) throw new Error('Deletion cancelled.');
          status.textContent = 'Processing your deletion request…';
          const result = await call('/v1/public-deletion/confirm', { confirm: true, challengeId: challenge.id, idToken: credential });
          document.querySelector('#google').replaceChildren();
          status.textContent = result.status === 'deleted' ? 'Deletion complete. If this Google account had a game profile, it has been removed.' : 'Deletion accepted. Access is blocked and the cloud save removed; authorization cleanup will retry automatically.';
        } catch (error) { status.textContent = error.message; document.querySelector('#start').disabled = false; }
      } });
    google.accounts.id.renderButton(document.querySelector('#google'), { theme: 'outline', size: 'large', text: 'signin_with' });
    status.textContent = 'Select the Google account you linked in the game to confirm deletion.';
  } catch (error) { status.textContent = error.message; document.querySelector('#start').disabled = false; }
});
`;
