'use strict';

// Resets the administrator username and password from the terminal.
// Use this when the console password has been forgotten:  npm run passwd

const readline = require('node:readline');

const db = require('../db');
const auth = require('../auth');

function ask(question, { silent = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (!silent) {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }
    // Suppress echo so the password is not left on screen or in scrollback.
    process.stdout.write(question);
    const onData = (char) => {
      if (['\n', '\r', ''].includes(String(char))) {
        process.stdin.removeListener('data', onData);
        return;
      }
      readline.moveCursor(process.stdout, -1000, 0);
      readline.clearLine(process.stdout, 1);
      process.stdout.write(question + '*'.repeat(rl.line.length));
    };
    process.stdin.on('data', onData);
    rl.question('', (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  db.migrate();
  const existing = auth.getAdmin();
  if (!existing) {
    const bootstrap = auth.ensureAdminAccount();
    console.log(`Created administrator account "${bootstrap.username}".`);
  }
  const current = auth.getAdmin();
  console.log(`\nCurrent administrator username: ${current.username}\n`);

  const username = (await ask(`New username [${current.username}]: `)) || current.username;
  const password = await ask('New password: ', { silent: true });
  const confirm = await ask('Confirm password: ', { silent: true });

  if (password !== confirm) {
    console.error('\nThe two passwords do not match. Nothing was changed.');
    process.exit(1);
  }
  const problem = auth.passwordProblem(password);
  if (problem) {
    console.error(`\n${problem} Nothing was changed.`);
    process.exit(1);
  }

  auth.setCredentials({ username, password });
  // Anyone already signed in with the old password is signed out.
  auth.destroyAllSessions();
  console.log(`\nUpdated. Sign in as "${username}". All existing sessions were signed out.`);
  db.close();
}

main().catch((error) => {
  console.error('Failed:', error.message);
  process.exit(1);
});
