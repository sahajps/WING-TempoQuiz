'use strict';

(() => {
  const code = (window.location.pathname.split('/').pop() || '').toUpperCase();
  const session = TQ.store.get(`tq.player.${code}`);
  const stage = TQ.$('#stage');

  if (!session || !session.token) {
    window.location.replace(`/join/${code}`);
    return;
  }

  const authHeader = { 'x-player-token': session.token };

  let state = null;
  let submitting = false;
  // Which question the locally rendered choices belong to, so a poll response
  // does not wipe out a tap that is still in flight.
  let renderedKey = '';
  let pendingChoice = null;
  let timerHandle = null;

  // --- rendering ------------------------------------------------------------

  function setStage(...nodes) {
    TQ.clear(stage);
    stage.append(...nodes);
  }

  function timerRow(endsMs, totalSeconds) {
    const bar = TQ.el('div', { class: 'timerbar' }, [TQ.el('div', { class: 'timerbar__fill' })]);
    const label = TQ.el('div', { class: 'timer tnum center', style: 'margin-bottom:.4rem' });
    const wrap = TQ.el('div', { style: 'margin-bottom:1.1rem' }, [label, bar]);

    const fill = bar.firstChild;
    function tick() {
      const remaining = Math.max(0, (endsMs - TQ.clock.now()) / 1000);
      label.textContent = TQ.seconds(remaining);
      const ratio = Math.max(0, Math.min(1, remaining / totalSeconds));
      fill.style.width = `${ratio * 100}%`;

      const urgent = remaining <= 5;
      const warn = remaining <= 10;
      label.classList.toggle('timer--urgent', urgent);
      label.classList.toggle('timer--warn', warn && !urgent);
      fill.classList.toggle('timerbar__fill--urgent', urgent);
      fill.classList.toggle('timerbar__fill--warn', warn && !urgent);
    }
    tick();
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = setInterval(tick, 200);
    return wrap;
  }

  function stopTimer() {
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
  }

  function questionHeader(question, total) {
    return TQ.el('p', {
      class: 'eyebrow eyebrow--orange',
      text: `Question ${question.position} of ${total}`,
    });
  }

  function questionBody(question) {
    const parts = [TQ.el('h1', { class: 'qprompt', text: question.prompt })];
    if (question.imageUrl) {
      parts.push(TQ.el('img', {
        class: 'qimage',
        src: question.imageUrl,
        alt: question.imageAlt || '',
        loading: 'eager',
      }));
    }
    return parts;
  }

  /** Renders the answer buttons for a question that is currently open. */
  function renderChoices(question) {
    const wrap = TQ.el('div', {
      class: `choices${question.options.length > 4 ? '' : ' choices--two'}`,
    });

    question.options.forEach((option) => {
      const button = TQ.el('button', {
        class: `choice choice--${option.index % 6}`,
        type: 'button',
        onclick: () => answer(question, option.index, wrap),
      }, [
        TQ.el('span', { class: 'choice__key', text: TQ.letter(option.index) }),
        TQ.el('span', { class: 'choice__text', text: option.text }),
      ]);
      button.dataset.index = String(option.index);
      wrap.append(button);
    });
    return wrap;
  }

  /** Renders the same question after it has closed, with the answer revealed. */
  function renderRevealed(question, myAnswer) {
    const wrap = TQ.el('div', {
      class: `choices${question.options.length > 4 ? '' : ' choices--two'}`,
    });

    question.options.forEach((option) => {
      const isAnswer = option.index === question.answerIndex;
      const isMine = myAnswer && myAnswer.choiceIndex === option.index;
      const classes = ['choice', `choice--${option.index % 6}`];
      if (isAnswer) classes.push('choice--correct');
      else if (isMine) classes.push('choice--wrong');
      else classes.push('choice--muted');

      const marks = [];
      if (isMine) marks.push('YOUR ANSWER');
      if (isAnswer) marks.push('CORRECT');

      wrap.append(TQ.el('div', { class: classes.join(' ') }, [
        TQ.el('span', { class: 'choice__key', text: TQ.letter(option.index) }),
        TQ.el('span', { class: 'choice__text', text: option.text }),
        marks.length ? TQ.el('span', { class: 'choice__mark', text: marks.join(' · ') }) : null,
      ]));
    });
    return wrap;
  }

  function standingsTable(rows, myNickname) {
    const body = TQ.el('tbody');
    rows.forEach((row) => {
      const tr = TQ.el('tr', {}, [
        TQ.el('td', { style: 'width:2.4rem' }, [
          TQ.el('span', { class: `rank${row.rank <= 3 ? ` rank--${row.rank}` : ''}`, text: row.rank }),
        ]),
        TQ.el('td', { text: row.nickname }),
        TQ.el('td', { class: 'num tnum', text: row.score }),
      ]);
      if (row.nickname === myNickname) tr.style.background = 'var(--orange-tint)';
      body.append(tr);
    });

    return TQ.el('div', { class: 'panel', style: 'margin-top:1.25rem' }, [
      TQ.el('div', { class: 'panel__head' }, [TQ.el('h3', { text: 'Standings' })]),
      TQ.el('div', { class: 'table-wrap' }, [
        TQ.el('table', { class: 'table' }, [
          TQ.el('thead', {}, [TQ.el('tr', {}, [
            TQ.el('th', { text: '#' }),
            TQ.el('th', { text: 'Nickname' }),
            TQ.el('th', { class: 'num', text: 'Score' }),
          ])]),
          body,
        ]),
      ]),
    ]);
  }

  // --- phases ---------------------------------------------------------------

  function renderLobby() {
    stopTimer();
    setStage(TQ.el('div', { class: 'bigstate' }, [
      TQ.el('div', { class: 'bigstate__icon pulse', text: '·' }),
      TQ.el('h2', { text: "You're in" }),
      TQ.el('p', { class: 'muted', text: 'Waiting for your instructor to release the first question.' }),
      TQ.el('p', { class: 'tiny muted', text: `${state.participantCount} in the room` }),
    ]));
  }

  function renderReady(question) {
    const startsMs = new Date(question.startsAt).getTime();
    const label = TQ.el('div', { class: 'countdown tnum' });

    const tick = () => {
      const left = Math.max(0, Math.ceil((startsMs - TQ.clock.now()) / 1000));
      label.textContent = String(left || 1);
    };
    tick();
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = setInterval(tick, 100);

    setStage(TQ.el('div', { class: 'bigstate' }, [
      TQ.el('p', { class: 'eyebrow eyebrow--orange', text: `Question ${question.position}` }),
      TQ.el('h2', { text: 'Get ready' }),
      label,
      TQ.el('p', { class: 'muted', text: 'The timer starts in a moment.' }),
    ]));
  }

  function renderOpen(question) {
    const total = state.quiz.questionCount;
    const endsMs = new Date(question.endsAt).getTime();

    if (state.myAnswer) {
      stopTimer();
      setStage(
        questionHeader(question, total),
        timerRow(endsMs, question.timeLimit),
        TQ.el('div', { class: 'bigstate' }, [
          TQ.el('div', { class: 'bigstate__icon bigstate__icon--ok', text: '✓' }),
          TQ.el('h2', { text: 'Answer locked in' }),
          TQ.el('p', {
            class: 'muted',
            text: `You chose ${TQ.letter(state.myAnswer.choiceIndex)}. Results appear when the timer ends.`,
          }),
        ]),
      );
      return;
    }

    setStage(
      questionHeader(question, total),
      timerRow(endsMs, question.timeLimit),
      ...questionBody(question),
      renderChoices(question),
    );
  }

  function renderClosed(question) {
    stopTimer();
    const total = state.quiz.questionCount;
    const mine = state.myAnswer;
    const nodes = [questionHeader(question, total)];

    if (mine) {
      nodes.push(TQ.el('div', { class: 'bigstate', style: 'padding:1.25rem 1rem 1rem' }, [
        TQ.el('div', {
          class: `bigstate__icon ${mine.correct ? 'bigstate__icon--ok' : 'bigstate__icon--bad'}`,
          text: mine.correct ? '✓' : '✕',
        }),
        TQ.el('h2', { text: mine.correct ? 'Correct' : 'Not this time' }),
        TQ.el('p', {
          class: 'muted',
          text: mine.correct ? `+${mine.points} points` : 'No points for this question.',
        }),
      ]));
    } else {
      nodes.push(TQ.el('div', { class: 'notice notice--warn', text: 'You did not answer this question.' }));
    }

    nodes.push(TQ.el('hr', { class: 'divider' }));
    nodes.push(...questionBody(question));
    nodes.push(renderRevealed(question, mine));

    if (state.showStandings && state.standings) {
      nodes.push(standingsTable(state.standings, state.me.nickname));
    } else {
      nodes.push(TQ.el('p', { class: 'tiny muted center', style: 'margin-top:1.1rem',
        text: 'Rankings are hidden for this question.' }));
    }
    setStage(...nodes);
  }

  function renderFinished() {
    stopTimer();
    const nodes = [
      TQ.el('div', { class: 'bigstate', style: 'padding:1.75rem 1rem 1rem' }, [
        TQ.el('div', { class: 'bigstate__icon', text: '★' }),
        TQ.el('h2', { text: 'Quiz complete' }),
        TQ.el('p', { class: 'muted' }, [
          'You finished ',
          TQ.el('strong', { text: state.me.rank ? `#${state.me.rank}` : '—' }),
          ` of ${state.me.total} with `,
          TQ.el('strong', { text: `${state.me.score} points` }),
          '.',
        ]),
      ]),
    ];

    if (state.standings) nodes.push(standingsTable(state.standings, state.me.nickname));

    if (state.review) {
      nodes.push(TQ.el('hr', { class: 'divider' }));
      nodes.push(TQ.el('p', { class: 'eyebrow eyebrow--orange', text: `Reviewing question ${state.review.position}` }));
      nodes.push(...questionBody(state.review));
      nodes.push(renderRevealed(state.review, null));
    }
    setStage(...nodes);
  }

  // --- answering ------------------------------------------------------------

  async function answer(question, index, wrap) {
    if (submitting || state.myAnswer) return;
    submitting = true;
    pendingChoice = index;

    // Reflect the tap immediately; a phone on a slow link should not feel dead.
    TQ.$$('.choice', wrap).forEach((button) => {
      button.disabled = true;
      button.classList.toggle('choice--picked', Number(button.dataset.index) === index);
      if (Number(button.dataset.index) !== index) button.classList.add('choice--muted');
    });

    try {
      await TQ.post(`/api/play/${code}/answer`, { questionId: question.id, choiceIndex: index }, authHeader);
      poller.now();
    } catch (error) {
      pendingChoice = null;
      TQ.fail(error);
      // Re-enable so the student can try again while the question is still open.
      TQ.$$('.choice', wrap).forEach((button) => {
        button.disabled = false;
        button.classList.remove('choice--picked', 'choice--muted');
      });
    } finally {
      submitting = false;
    }
  }

  // --- polling --------------------------------------------------------------

  function render() {
    TQ.$('#who').textContent = state.me.nickname;
    TQ.$('#score').textContent = `${state.me.score} pts`;

    const question = state.current;
    const phase = state.phase;
    // Re-render only when the meaningful state changes, so an open question's
    // buttons are not rebuilt under the student's finger every poll.
    const key = [
      phase,
      question ? question.id : 'none',
      state.myAnswer ? state.myAnswer.choiceIndex : 'na',
      state.showStandings ? 'rank' : 'norank',
      state.review ? state.review.position : 'noreview',
      phase === 'closed' || phase === 'finished' ? JSON.stringify(state.standings || []) : '',
      phase === 'lobby' || !question ? state.participantCount : '',
    ].join('|');

    if (key === renderedKey) return;
    renderedKey = key;

    if (phase === 'finished') return renderFinished();
    if (!question || phase === 'pending') return renderLobby();
    if (phase === 'ready') return renderReady(question);
    if (phase === 'open') return renderOpen(question);
    return renderClosed(question);
  }

  async function refresh() {
    const next = await TQ.get(`/api/play/${code}/state`, authHeader);
    TQ.clock.sync(next.serverTime);
    state = next;
    if (state.myAnswer) pendingChoice = null;
    render();
  }

  const poller = TQ.poll(async () => {
    try {
      await refresh();
    } catch (error) {
      if (error.status === 403 || error.status === 404) {
        stopTimer();
        setStage(TQ.el('div', { class: 'bigstate' }, [
          TQ.el('div', { class: 'bigstate__icon bigstate__icon--bad', text: '!' }),
          TQ.el('h2', { text: 'You have been signed out of this room' }),
          TQ.el('p', { class: 'muted', text: error.message }),
          TQ.el('a', { class: 'btn btn--primary', href: `/join/${code}` }, ['Join again']),
        ]));
      }
      throw error;
    }
  }, 1000);

  // A phone that has been asleep has a stale screen; refresh the moment it wakes.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poller.now();
  });

  window.addEventListener('pagehide', () => {
    poller.stop();
    stopTimer();
  });
})();
