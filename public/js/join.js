'use strict';

(() => {
  const code = (window.location.pathname.split('/').pop() || '').toUpperCase();

  const form = TQ.$('#join-form');
  const nickname = TQ.$('#nickname');
  const suffix = TQ.$('#suffix');
  const errorBox = TQ.$('#join-error');

  function showError(message) {
    TQ.clear(errorBox);
    errorBox.append(TQ.el('div', { class: 'notice notice--error', text: message }));
    TQ.show(errorBox, true);
  }

  function panel(id) {
    for (const name of ['loading', 'room', 'closed', 'waiting', 'missing']) {
      TQ.show(TQ.$(`#${name}`), name === id);
    }
  }

  // Set while the room is prepared but not yet open, so a student who scans
  // the code early is let in automatically instead of having to retry.
  let waitTimer = null;

  async function load() {
    if (waitTimer) {
      clearTimeout(waitTimer);
      waitTimer = null;
    }
    try {
      const lobby = await TQ.get(`/api/play/${code}`);
      if (lobby.status === 'finished') {
        panel('closed');
        return;
      }
      if (lobby.open === false) {
        TQ.$('#waiting-detail').textContent =
          `“${lobby.name}” has not opened yet. Keep this page open — it will let you in as soon as your instructor opens the room.`;
        document.title = `${lobby.name} · TempoQuiz`;
        panel('waiting');
        waitTimer = setTimeout(load, 5000);
        return;
      }
      TQ.$('#room-code').textContent = lobby.code;
      TQ.$('#room-name').textContent = lobby.name;
      TQ.$('#room-meta').textContent = lobby.participantCount === 1
        ? '1 person has joined so far.'
        : `${lobby.participantCount} people have joined so far.`;
      document.title = `${lobby.name} · TempoQuiz`;
      panel('room');

      // The nickname is remembered between quizzes; the Student ID suffix
      // deliberately is not, so it is never left behind on a shared device.
      const remembered = TQ.store.getLocal('tq.nickname', '');
      if (remembered) nickname.value = remembered;
      (remembered ? suffix : nickname).focus();
    } catch (error) {
      if (error.status === 404) {
        panel('missing');
        return;
      }
      TQ.$('#missing-detail').textContent = error.message;
      panel('missing');
    }
  }

  suffix.addEventListener('input', () => {
    const cleaned = suffix.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (cleaned !== suffix.value) suffix.value = cleaned;
    TQ.show(errorBox, false);
  });

  nickname.addEventListener('input', () => TQ.show(errorBox, false));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const nick = nickname.value.trim();
    const sfx = suffix.value.trim().toUpperCase();

    if (nick.length < 2) {
      showError('Enter a nickname of at least two characters.');
      nickname.focus();
      return;
    }
    if (!/^[A-Z0-9]{4}$/.test(sfx)) {
      showError('Enter the last 4 characters of your Student ID, for example 123E.');
      suffix.focus();
      return;
    }

    const button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Joining…';
    try {
      const result = await TQ.post(`/api/play/${code}/join`, { nickname: nick, studentId: sfx });
      TQ.store.setLocal('tq.nickname', nick);
      // The play token lives in session storage: it survives a refresh but not
      // a closed tab, and is never written to the URL.
      TQ.store.set(`tq.player.${code}`, { token: result.token, nickname: result.nickname });
      window.location.href = `/play/${code}`;
    } catch (error) {
      showError(error.message);
      button.disabled = false;
      button.textContent = 'Join the quiz';
    }
  });

  load();
})();
