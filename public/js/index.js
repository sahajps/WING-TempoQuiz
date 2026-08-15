'use strict';

(() => {
  const form = TQ.$('#join-form');
  const input = TQ.$('#code');
  const errorBox = TQ.$('#join-error');

  function showError(message) {
    TQ.clear(errorBox);
    errorBox.append(TQ.el('div', { class: 'notice notice--error', text: message }));
    TQ.show(errorBox, true);
  }

  // Keep the field to the room-code alphabet as it is typed, so a pasted code
  // with spaces or lower case still works.
  input.addEventListener('input', () => {
    const cleaned = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (cleaned !== input.value) input.value = cleaned;
    TQ.show(errorBox, false);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = input.value.trim().toUpperCase();
    if (code.length !== 6) {
      showError('A room code is six characters long.');
      input.focus();
      return;
    }

    const button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      // Confirm the room exists before navigating, so a typo is reported here
      // rather than on a dead-end page.
      const lobby = await TQ.get(`/api/play/${code}`);
      if (lobby.status === 'finished') {
        showError('That quiz has already finished.');
        return;
      }
      window.location.href = `/join/${code}`;
    } catch (error) {
      showError(error.status === 404
        ? 'No quiz has that room code. Check the code on screen and try again.'
        : error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Continue';
    }
  });

  input.focus();
})();
