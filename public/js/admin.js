'use strict';

(() => {
  const loginForm = TQ.$('#login-form');
  const changeForm = TQ.$('#change-form');

  // Kept in memory only, purely so the forced password change can prove the
  // caller knows the current password. Never written to storage.
  let temporaryPassword = '';

  function setError(boxId, message) {
    const box = TQ.$(`#${boxId}`);
    TQ.clear(box);
    if (!message) {
      TQ.show(box, false);
      return;
    }
    box.append(TQ.el('div', { class: 'notice notice--error', text: message }));
    TQ.show(box, true);
  }

  function showChangePanel(username) {
    TQ.show(TQ.$('#panel-login'), false);
    TQ.show(TQ.$('#panel-change'), true);
    TQ.$('#new-username').value = username || '';
    TQ.$('#new-password').focus();
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError('login-error', '');

    const username = TQ.$('#username').value.trim();
    const password = TQ.$('#password').value;
    if (!username || !password) {
      setError('login-error', 'Enter both your username and password.');
      return;
    }

    const button = loginForm.querySelector('button');
    button.disabled = true;
    button.textContent = 'Signing in…';
    try {
      const result = await TQ.post('/api/admin/login', { username, password });
      TQ.setCsrf(result.csrfToken);
      if (result.mustChangePassword) {
        temporaryPassword = password;
        showChangePanel(result.username);
        return;
      }
      window.location.href = '/admin/console';
    } catch (error) {
      setError('login-error', error.message);
      TQ.$('#password').value = '';
      TQ.$('#password').focus();
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });

  changeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError('change-error', '');

    const username = TQ.$('#new-username').value.trim();
    const password = TQ.$('#new-password').value;
    const confirm = TQ.$('#confirm-password').value;

    if (password !== confirm) {
      setError('change-error', 'The two passwords do not match.');
      return;
    }
    if (password.length < 10) {
      setError('change-error', 'The password must be at least 10 characters.');
      return;
    }

    const button = changeForm.querySelector('button');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const result = await TQ.post('/api/admin/credentials', {
        currentPassword: temporaryPassword,
        username,
        newPassword: password,
      });
      TQ.setCsrf(result.csrfToken);
      temporaryPassword = '';
      window.location.href = '/admin/console';
    } catch (error) {
      setError('change-error', error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Save and continue';
    }
  });

  // Skip the form entirely if a valid session is already in place.
  (async () => {
    try {
      const session = await TQ.get('/api/admin/session');
      if (session.authenticated && !session.mustChangePassword && TQ.csrf()) {
        window.location.replace('/admin/console');
        return;
      }
    } catch { /* not signed in; show the form */ }
    TQ.$('#username').focus();
  })();
})();
