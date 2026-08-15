'use strict';

(() => {
  const code = (window.location.pathname.split('/').pop() || '').toUpperCase();
  const main = TQ.$('#main');
  const statusBadge = TQ.$('#status-badge');

  let hostToken = TQ.store.get(`tq.host.${code}`, null);
  let state = null;
  let renderedKey = '';
  let timerHandle = null;
  let busy = false;

  // Audio bookkeeping. Kept at module scope so a re-render mid-question does
  // not restart the tick sequence or replay the buzzer.
  let lastTickSecond = null;
  let previousPhase = null;
  let applauseTimer = null;

  const muteButton = TQ.$('#mute-toggle');

  function paintMuteButton() {
    const off = TQSound.isMuted();
    muteButton.textContent = off ? 'Sound off' : 'Sound on';
    muteButton.setAttribute('aria-pressed', String(off));
  }

  muteButton.addEventListener('click', () => {
    TQSound.toggle();
    paintMuteButton();
  });
  paintMuteButton();

  const authHeader = () => (hostToken ? { 'x-host-token': hostToken } : {});

  // --- helpers --------------------------------------------------------------

  function stopTimer() {
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
  }

  /** Runs a host action, guarding against double-clicks on the control bar. */
  async function act(label, fn) {
    if (busy) return;
    busy = true;
    try {
      await fn();
      await refresh();
    } catch (error) {
      TQ.fail(error);
    } finally {
      busy = false;
    }
  }

  function post(path, body) {
    return TQ.post(path, { ...(body || {}), ...(hostToken ? { hostToken } : {}) });
  }

  function panel(headChildren, bodyChildren, footChildren) {
    return TQ.el('section', { class: 'panel' }, [
      headChildren ? TQ.el('div', { class: 'panel__head' }, headChildren) : null,
      TQ.el('div', { class: 'panel__body' }, bodyChildren),
      footChildren ? TQ.el('div', { class: 'panel__foot' }, footChildren) : null,
    ]);
  }

  // --- lobby ----------------------------------------------------------------

  function lobbyView() {
    const joinUrl = state.joinUrl;
    // Older servers did not have the concept, so anything but an explicit
    // false means the room is joinable.
    const open = state.quiz.open !== false;

    // Before the room opens there is deliberately no QR code: a code on the
    // projector that turns students away is worse than no code at all.
    const left = TQ.el('section', { class: 'panel' }, [
      open
        ? TQ.el('div', { class: 'panel__body center' }, [
            TQ.el('p', { class: 'eyebrow eyebrow--orange', text: 'Join at' }),
            TQ.el('p', { class: 'joinurl', style: 'margin-bottom:1.1rem', text: joinUrl }),
            TQ.el('div', { class: 'qr-frame', style: 'width:min(340px, 70vw)' }, [
              TQ.el('img', { src: `/api/quizzes/${code}/qr.svg`, alt: `QR code linking to ${joinUrl}` }),
            ]),
            TQ.el('p', { class: 'eyebrow', style: 'margin-top:1.4rem', text: 'Room code' }),
            TQ.el('p', { class: 'roomcode', text: state.quiz.code }),
          ])
        : TQ.el('div', { class: 'panel__body center' }, [
            TQ.el('p', { class: 'eyebrow', text: 'Prepared' }),
            TQ.el('h2', { style: 'font-size:1.5rem;margin:.4rem 0 1.1rem', text: state.quiz.name }),
            TQ.el('p', { class: 'muted', style: 'max-width:34ch;margin:0 auto',
              text: 'This quiz is saved and ready. The QR code and the room code appear once you open the room.' }),
            TQ.el('p', { class: 'hint', style: 'margin-top:1.4rem',
              text: `Prepared ${TQ.dateTime(state.quiz.createdAt)}` }),
          ]),
    ]);

    const roster = state.participants.length
      ? TQ.el('div', { class: 'row', style: 'gap:.4rem' },
          state.participants.map((p) => TQ.el('span', { class: 'badge badge--lobby', text: p.nickname })))
      : TQ.el('p', { class: 'empty', text: 'Nobody has joined yet.' });

    const right = TQ.el('div', { class: 'stack', style: '--gap:1.25rem' }, [
      panel(
        [TQ.el('h2', { text: state.quiz.name })],
        [
          TQ.el('div', { class: 'stats' }, [
            statTile(state.participants.length, 'In the room'),
            statTile(state.quiz.questionCount, 'Questions'),
          ]),
          TQ.el('p', { class: 'hint', style: 'margin-top:.9rem',
            text: open
              ? 'Students can keep joining after the quiz starts, but they will miss any question already released.'
              : 'Nobody can join until you open the room, so a quiz can sit here for days. Open it when the lecture starts.' }),
        ],
        [
          open
            ? TQ.el('div', { class: 'stack', style: '--gap:.5rem' }, [
                TQ.el('button', {
                  class: 'btn btn--go btn--lg btn--block',
                  type: 'button',
                  onclick: () => act('release', () => post(`/api/quizzes/${code}/release`)),
                }, ['Release question 1']),
                // Only useful before the quiz starts: for a room opened by
                // mistake, or one being put away until the lecture.
                TQ.el('button', {
                  class: 'btn btn--sm btn--ghost btn--block',
                  type: 'button',
                  onclick: () => act('close-room', () => post(`/api/quizzes/${code}/close-room`)),
                }, ['Close the room again']),
              ])
            : TQ.el('button', {
                class: 'btn btn--go btn--lg btn--block',
                type: 'button',
                onclick: () => act('open', () => post(`/api/quizzes/${code}/open`)),
              }, ['Open the room']),
        ],
      ),
      panel([TQ.el('h3', { text: 'In the room' }), TQ.el('span', { class: 'muted small', text: `${state.participants.length}` })], [roster]),
      outlinePanel(),
    ]);

    return TQ.el('div', { class: 'hostgrid' }, [left, right]);
  }

  function statTile(value, label, modifier) {
    return TQ.el('div', { class: `stat${modifier ? ` stat--${modifier}` : ''}` }, [
      TQ.el('div', { class: 'stat__value', text: value }),
      TQ.el('div', { class: 'stat__label', text: label }),
    ]);
  }

  // --- running --------------------------------------------------------------

  function timerBlock(question, phase) {
    const wrap = TQ.el('div');
    if (phase === 'closed') {
      wrap.append(TQ.el('p', { class: 'eyebrow', text: 'Question closed' }));
      return wrap;
    }

    const label = TQ.el('div', { class: 'timer tnum' });
    const bar = TQ.el('div', { class: 'timerbar', style: 'margin-top:.5rem' }, [TQ.el('div', { class: 'timerbar__fill' })]);
    const fill = bar.firstChild;
    const startsMs = new Date(question.startsAt).getTime();
    const endsMs = new Date(question.endsAt).getTime();

    function tick() {
      const now = TQ.clock.now();
      if (now < startsMs) {
        label.textContent = 'ready';
        label.className = 'timer';
        fill.style.width = '100%';
        return;
      }
      const remaining = Math.max(0, (endsMs - now) / 1000);

      // One tick per whole second, driven off the local clock rather than the
      // poll, so the sound stays in step with the digits on screen.
      const whole = Math.ceil(remaining);
      if (whole !== lastTickSecond) {
        lastTickSecond = whole;
        if (whole > 0 && phase !== 'closed') TQSound.tick(whole <= 5);
      }

      label.textContent = TQ.seconds(remaining);
      const ratio = Math.max(0, Math.min(1, remaining / question.timeLimit));
      fill.style.width = `${ratio * 100}%`;
      const urgent = remaining <= 5;
      const warn = remaining <= 10;
      label.className = `timer tnum${urgent ? ' timer--urgent' : warn ? ' timer--warn' : ''}`;
      fill.className = `timerbar__fill${urgent ? ' timerbar__fill--urgent' : warn ? ' timerbar__fill--warn' : ''}`;
    }
    tick();
    stopTimer();
    timerHandle = setInterval(tick, 200);

    wrap.append(label, bar);
    return wrap;
  }

  function tallyList(question, reveal) {
    const total = question.tally.reduce((sum, n) => sum + n, 0) || 1;
    return TQ.el('div', { class: 'tally' }, question.options.map((option) => {
      const count = question.tally[option.index] || 0;
      const isCorrect = option.index === question.answerIndex;
      const row = TQ.el('div', {
        class: `tallyrow${reveal && isCorrect ? ' is-correct' : ''}`,
        style: `--choice-accent: var(--choice-${option.index}, #23387e)`,
      }, [
        TQ.el('span', { class: 'tallyrow__key', text: TQ.letter(option.index) }),
        TQ.el('span', { class: 'tallyrow__text', text: option.text + (reveal && isCorrect ? '  ✓' : '') }),
        TQ.el('span', { class: 'tallyrow__bar' }, [
          TQ.el('span', { class: 'tallyrow__fill', style: `width:${(count / total) * 100}%` }),
        ]),
        TQ.el('span', { class: 'tallyrow__n tnum', text: count }),
      ]);
      // Inline the accent so the tally bars match the student's answer colours.
      row.style.setProperty('--choice-accent', ['#23387e', '#ee6c21', '#17706a', '#7b3f8c', '#5c6e1e', '#a32b2b'][option.index % 6]);
      return row;
    }));
  }

  function runningView() {
    const question = state.current;
    const phase = state.phase;
    const reveal = phase === 'closed';
    const isLast = state.quiz.currentIndex + 1 >= state.quiz.questionCount;

    const controls = TQ.el('div', { class: 'row' }, [
      phase !== 'closed'
        ? TQ.el('button', {
            class: 'btn', type: 'button',
            onclick: () => act('close', () => post(`/api/quizzes/${code}/close`)),
          }, ['Close now'])
        : null,
      !isLast
        ? TQ.el('button', {
            class: 'btn btn--go', type: 'button',
            onclick: () => act('release', () => post(`/api/quizzes/${code}/release`)),
          }, [`Release question ${state.quiz.currentIndex + 2}`])
        : null,
      TQ.el('button', {
        class: isLast ? 'btn btn--go' : 'btn',
        type: 'button',
        onclick: () => {
          if (!window.confirm('Finish the quiz and show the final leaderboard? No further questions can be released.')) return;
          act('finish', () => post(`/api/quizzes/${code}/finish`));
        },
      }, ['Finish quiz']),
    ]);

    const left = TQ.el('div', { class: 'stack', style: '--gap:1.25rem' }, [
      panel(
        [
          TQ.el('h2', { text: `Question ${question.position} of ${state.quiz.questionCount}` }),
          TQ.el('div', { class: 'row' }, [
            TQ.el('span', { class: 'livedot' + (phase === 'open' ? '' : ' livedot--idle') }),
            TQ.el('span', { class: 'small muted tnum', text: `${state.answered} of ${state.participants.length} answered` }),
          ]),
        ],
        [
          timerBlock(question, phase),
          TQ.el('hr', { class: 'divider' }),
          TQ.el('p', { class: 'qprompt', style: 'font-size:1.3rem', text: question.prompt }),
          question.imageUrl
            ? TQ.el('img', { class: 'qimage', src: question.imageUrl, alt: question.imageAlt || '' })
            : null,

          // While the question is open the class sees only how many people
          // have answered, never which option they picked. Showing a running
          // tally on the projector would pull undecided students towards
          // whichever bar was longest.
          ...(reveal
            ? [
                TQ.el('p', { class: 'eyebrow', style: 'margin-top:1.1rem', text: 'Results' }),
                tallyList(question, true),
              ]
            : [
                // Options are shown so the room can read the question off the
                // projector; only the counts are held back.
                TQ.el('p', { class: 'eyebrow', style: 'margin-top:1.1rem', text: 'Options' }),
                // Deliberately a different class from .tallyrow: these carry no
                // counts, and the two states should not be confusable either
                // visually or in the markup.
                TQ.el('div', { class: 'tally' }, question.options.map((option) => {
                  const row = TQ.el('div', { class: 'optionrow' }, [
                    TQ.el('span', { class: 'tallyrow__key', text: TQ.letter(option.index) }),
                    TQ.el('span', { class: 'tallyrow__text', text: option.text }),
                  ]);
                  row.style.setProperty('--choice-accent',
                    ['#23387e', '#ee6c21', '#17706a', '#7b3f8c', '#5c6e1e', '#a32b2b'][option.index % 6]);
                  return row;
                })),
                TQ.el('div', { class: 'answered-meter', style: 'margin-top:1.1rem' }, [
                  TQ.el('div', { class: 'row row--between' }, [
                    TQ.el('span', { class: 'eyebrow', style: 'margin:0', text: 'Answers in' }),
                    TQ.el('span', {
                      class: 'tnum',
                      style: 'font-weight:680;font-size:1.15rem',
                      text: `${state.answered} / ${state.participants.length}`,
                    }),
                  ]),
                  TQ.el('div', { class: 'timerbar', style: 'margin-top:.45rem' }, [
                    TQ.el('div', {
                      class: 'timerbar__fill',
                      style: `width:${state.participants.length
                        ? (state.answered / state.participants.length) * 100
                        : 0}%;background:var(--green)`,
                    }),
                  ]),
                  TQ.el('p', { class: 'hint', text: 'The breakdown and the correct answer appear when the timer ends.' }),
                ]),
              ]),
        ],
        [controls],
      ),
      // The leaderboard after every question, as soon as it closes.
      reveal ? resultsLeaderboard() : null,
    ]);

    const right = TQ.el('div', { class: 'stack', style: '--gap:1.25rem' }, [
      joinCard(),
      outlinePanel(),
    ]);

    return TQ.el('div', { class: 'hostgrid' }, [left, right]);
  }

  function joinCard() {
    return panel(
      [TQ.el('h3', { text: 'Join' })],
      [
        TQ.el('div', { class: 'row', style: 'align-items:center;gap:1rem' }, [
          TQ.el('div', { class: 'qr-frame', style: 'width:104px;flex:none' }, [
            TQ.el('img', { src: `/api/quizzes/${code}/qr.svg`, alt: 'Join QR code' }),
          ]),
          TQ.el('div', { class: 'grow' }, [
            TQ.el('p', { class: 'roomcode', style: 'font-size:1.7rem', text: state.quiz.code }),
            TQ.el('p', { class: 'joinurl', style: 'margin-top:.4rem', text: state.joinUrl }),
          ]),
        ]),
      ],
    );
  }

  // --- finished -------------------------------------------------------------

  function finishedView() {
    stopTimer();

    // Questions are offered worst-answered first: the ones the class struggled
    // with are the ones worth spending the remaining minutes on.
    const byDifficulty = [...state.outline].sort((a, b) => {
      if (a.correctRate === null) return 1;
      if (b.correctRate === null) return -1;
      return a.correctRate - b.correctRate;
    });

    const reviewPicker = TQ.el('select', {
      'aria-label': 'Question to review',
      onchange: (event) => {
        const value = event.target.value;
        act('review', () => post(`/api/quizzes/${code}/review`, { position: value === '' ? null : Number(value) }));
      },
    }, [
      TQ.el('option', { value: '', text: 'Choose a question to review…' }),
      ...byDifficulty.map((q) => TQ.el('option', {
        value: q.position,
        selected: state.quiz.reviewPosition === q.position,
        text: `Q${q.position} · ${q.correctRate === null ? 'no answers' : `${q.correctRate}% correct`} · ${(q.prompt || '').slice(0, 60)}`,
      })),
    ]);

    const reviewed = state.review;
    const outlineEntry = reviewed
      ? state.outline.find((q) => q.position === reviewed.position)
      : null;

    const reviewBody = [
      TQ.el('div', { class: 'row', style: 'margin-bottom:.9rem' }, [
        TQ.el('span', { class: 'grow' }, [reviewPicker]),
        reviewed
          ? TQ.el('button', {
              class: 'btn btn--sm', type: 'button',
              onclick: () => act('review', () => post(`/api/quizzes/${code}/review`, { position: null })),
            }, ['Clear'])
          : null,
      ]),
    ];

    if (reviewed) {
      reviewBody.push(
        TQ.el('div', { class: 'row row--between', style: 'margin-bottom:.5rem' }, [
          TQ.el('p', { class: 'eyebrow eyebrow--orange', style: 'margin:0',
            text: `Question ${reviewed.position} of ${state.quiz.questionCount}` }),
          outlineEntry && outlineEntry.correctRate !== null
            ? TQ.el('span', {
                class: `badge badge--${outlineEntry.correctRate < 50 ? 'used' : outlineEntry.correctRate < 80 ? 'reserved' : 'available'}`,
                text: `${outlineEntry.correctRate}% correct`,
              })
            : null,
        ]),
        TQ.el('p', { class: 'qprompt', style: 'font-size:1.35rem', text: reviewed.prompt }),
        reviewed.imageUrl
          ? TQ.el('img', { class: 'qimage', src: reviewed.imageUrl, alt: reviewed.imageAlt || '' })
          : null,
        TQ.el('p', { class: 'eyebrow', text: 'How the class answered' }),
        tallyList(reviewed, true),
        TQ.el('p', { class: 'hint', text: 'This question is now on every student screen, with the correct answer marked.' }),
      );
    } else {
      reviewBody.push(TQ.el('p', {
        class: 'empty',
        text: 'Pick a question above. It appears here and on every student screen, with the correct answer shown. The list is ordered worst-answered first.',
      }));
    }

    const left = TQ.el('div', { class: 'stack', style: '--gap:1.25rem' }, [
      panel([TQ.el('h2', { text: 'Class review' })], reviewBody),
    ]);

    const right = TQ.el('div', { class: 'stack', style: '--gap:1.25rem' }, [
      panel(
        [TQ.el('h3', { text: 'Download the record' })],
        [
          TQ.el('p', { class: 'hint', style: 'margin-top:0', text: 'The full record is also saved on the server as JSON.' }),
          TQ.el('div', { class: 'row' }, [
            exportButton('markdown', 'Markdown'),
            exportButton('csv', 'CSV'),
            exportButton('json', 'JSON'),
          ]),
        ],
      ),
      outlinePanel(),
    ]);

    return TQ.el('div', { class: 'hostgrid' }, [left, right]);
  }

  function exportButton(format, label) {
    return TQ.el('button', {
      class: 'btn btn--sm', type: 'button',
      onclick: async () => {
        try {
          await TQ.download(`/api/quizzes/${code}/export`,
            { format, ...(hostToken ? { hostToken } : {}) },
            `${code}.${format === 'markdown' ? 'md' : format}`);
        } catch (error) {
          TQ.fail(error);
        }
      },
    }, [label]);
  }

  // --- shared panels --------------------------------------------------------

  // Nicknames and scores only. Student numbers are deliberately absent from
  // the server payload, because this table is normally on a projector.
  function leaderboardTable() {
    if (!state.participants.length) {
      return TQ.el('p', { class: 'empty', text: 'No participants yet.' });
    }
    return TQ.el('div', { class: 'table-wrap' }, [
      TQ.el('table', { class: 'table' }, [
        TQ.el('thead', {}, [TQ.el('tr', {}, [
          TQ.el('th', { text: '#' }),
          TQ.el('th', { text: 'Nickname' }),
          TQ.el('th', { class: 'num', text: 'Score' }),
          TQ.el('th', { class: 'num', text: 'Right' }),
        ])]),
        TQ.el('tbody', {}, state.participants.map((p) => TQ.el('tr', {}, [
          TQ.el('td', {}, [TQ.el('span', { class: `rank${p.rank <= 3 ? ` rank--${p.rank}` : ''}`, text: p.rank })]),
          TQ.el('td', { text: p.nickname }),
          TQ.el('td', { class: 'num tnum', text: p.score }),
          TQ.el('td', { class: 'num tnum muted', text: `${p.correct}/${p.answered}` }),
        ]))),
      ]),
    ]);
  }

  /**
   * The between-questions leaderboard. Shown only once a question has closed,
   * so it never overlaps with students still choosing an answer. Nicknames
   * only — student IDs are not in the payload at all.
   */
  function resultsLeaderboard() {
    const top = state.participants.slice(0, 10);
    if (!top.length) {
      return panel([TQ.el('h3', { text: 'Leaderboard' })],
        [TQ.el('p', { class: 'empty', text: 'Nobody has answered yet.' })]);
    }

    const rows = top.map((p) => TQ.el('tr', {}, [
      TQ.el('td', { style: 'width:2.6rem' }, [
        TQ.el('span', { class: `rank${p.rank <= 3 ? ` rank--${p.rank}` : ''}`, text: p.rank }),
      ]),
      TQ.el('td', { style: 'font-weight:600', text: p.nickname }),
      TQ.el('td', { class: 'num tnum', style: 'font-weight:680', text: p.score }),
      TQ.el('td', { class: 'num tnum muted small', text: `${p.correct}/${p.answered}` }),
    ]));

    return TQ.el('section', { class: 'panel panel--spot' }, [
      TQ.el('div', { class: 'panel__head' }, [
        TQ.el('h2', { text: 'Leaderboard' }),
        TQ.el('span', { class: 'muted small', text: `after question ${state.quiz.currentIndex + 1}` }),
      ]),
      TQ.el('div', { class: 'panel__body panel__body--flush' }, [
        TQ.el('table', { class: 'table' }, [
          TQ.el('thead', {}, [TQ.el('tr', {}, [
            TQ.el('th', { text: '#' }),
            TQ.el('th', { text: 'Nickname' }),
            TQ.el('th', { class: 'num', text: 'Score' }),
            TQ.el('th', { class: 'num', text: 'Right' }),
          ])]),
          TQ.el('tbody', {}, rows),
        ]),
      ]),
      state.participants.length > top.length
        ? TQ.el('div', { class: 'panel__foot tiny muted' },
            [`Top ${top.length} of ${state.participants.length}.`])
        : null,
    ]);
  }

  function outlinePanel() {
    const items = state.outline.map((q) => TQ.el('li', {}, [
      TQ.el('div', { class: 'qrow', style: 'cursor:default' }, [
        TQ.el('span', {
          class: `qrow__no${q.position === state.quiz.currentIndex + 1 && state.quiz.status === 'running' ? ' qrow__no--live' : q.released ? ' qrow__no--done' : ''}`,
          text: q.position,
        }),
        TQ.el('div', { class: 'qrow__body' }, [
          // prompt is null until the question has been released, so an
          // unasked question cannot be read off the projector.
          q.prompt
            ? TQ.el('div', { class: 'qrow__text', text: q.prompt })
            : TQ.el('div', { class: 'qrow__text muted', text: `Question ${q.position} — hidden until released` }),
          TQ.el('div', { class: 'qrow__meta' }, [
            TQ.el('span', { text: `${q.timeLimit}s` }),
            q.correctRate !== null ? TQ.el('span', { text: `${q.correctRate}% correct` }) : null,
            !q.released ? TQ.el('span', { text: 'not released' }) : null,
          ]),
        ]),
      ]),
    ]));

    return TQ.el('section', { class: 'panel' }, [
      TQ.el('div', { class: 'panel__head' }, [
        TQ.el('h3', { text: 'Questions' }),
        TQ.el('span', { class: 'muted small', text: `${state.outline.length}` }),
      ]),
      TQ.el('div', { class: 'panel__body panel__body--flush' }, [
        TQ.el('ul', { class: 'qlist' }, items),
      ]),
      TQ.el('div', { class: 'panel__foot' }, [
        TQ.el('button', {
          class: 'btn btn--sm', type: 'button',
          onclick: openAppend,
        }, ['Add more questions']),
      ]),
    ]);
  }

  // --- append ---------------------------------------------------------------

  function openAppend() {
    if (state.quiz.status === 'finished') {
      TQ.toast('This quiz has finished; questions can no longer be added.', 'error');
      return;
    }
    const textarea = TQ.el('textarea', {
      class: 'code',
      placeholder: `## Question ${state.quiz.questionCount + 1}\n**Time:** 20\n\nYour question text\n\n- [x] Correct option\n- [ ] Second option\n- [ ] Third option\n- [ ] Fourth option`,
      style: 'min-height:220px',
    });
    const errorBox = TQ.el('div');

    const dialog = TQ.el('dialog', {
      style: 'border:1px solid var(--rule);border-radius:8px;padding:0;max-width:640px;width:calc(100vw - 2rem);box-shadow:var(--shadow-lg)',
    }, [
      TQ.el('form', { method: 'dialog' }, [
        TQ.el('div', { class: 'panel__head' }, [TQ.el('h3', { text: 'Add questions to this quiz' })]),
        TQ.el('div', { class: 'panel__body' }, [
          TQ.el('p', { class: 'hint', style: 'margin-top:0',
            text: `This quiz currently has ${state.quiz.questionCount} questions. Paste one or more complete "## Question" blocks, numbered from ${state.quiz.questionCount + 1}.` }),
          textarea,
          errorBox,
        ]),
        TQ.el('div', { class: 'panel__foot row row--end' }, [
          TQ.el('button', { class: 'btn', value: 'cancel', type: 'submit' }, ['Cancel']),
          TQ.el('button', {
            class: 'btn btn--primary', type: 'button',
            onclick: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              TQ.clear(errorBox);
              try {
                const result = await post(`/api/quizzes/${code}/append`, {
                  markdown: textarea.value,
                  expectedQuestionCount: state.quiz.questionCount,
                });
                TQ.toast(`Added ${result.added} question${result.added === 1 ? '' : 's'}.`, 'ok');
                dialog.close();
                dialog.remove();
                refresh();
              } catch (error) {
                const notes = error.details && error.details.errors;
                errorBox.append(TQ.el('div', { class: 'notice notice--error', style: 'margin-top:.8rem', text: error.message }));
                if (notes) {
                  errorBox.append(TQ.el('ul', { class: 'notes', style: 'margin-top:.5rem' },
                    notes.map((n) => TQ.el('li', {}, [
                      TQ.el('span', { class: 'notes__line', text: `L${n.line}` }),
                      TQ.el('span', { text: n.message }),
                    ]))));
                }
              } finally {
                button.disabled = false;
              }
            },
          }, ['Append']),
        ]),
      ]),
    ]);

    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
    textarea.focus();
  }

  // --- driver ---------------------------------------------------------------

  /**
   * Buzzer the moment a question closes, then applause once the leaderboard
   * has had a beat to appear. Nothing fires on the first render, so opening
   * the host screen on an already-closed question is silent.
   */
  function playPhaseCues(phase) {
    const closedNow = phase === 'closed' && previousPhase !== null && previousPhase !== 'closed';
    previousPhase = phase;
    if (!closedNow) return;

    lastTickSecond = null;
    TQSound.timeUp();
    clearTimeout(applauseTimer);
    // Long enough for the three buzzer notes to finish first.
    applauseTimer = setTimeout(() => TQSound.applause(), 1150);
  }

  function render() {
    const quiz = state.quiz;
    statusBadge.textContent = quiz.status;
    statusBadge.className = `badge badge--${quiz.status}`;
    document.title = `${quiz.name} · ${quiz.code} · TempoQuiz`;

    playPhaseCues(quiz.status === 'finished' ? 'finished' : state.phase);

    // Rebuild only when something visible changes; the timer updates itself.
    const key = [
      quiz.status, quiz.open, quiz.currentIndex, state.phase, state.answered,
      state.participants.length, quiz.questionCount, quiz.reviewPosition,
      state.standingsVisible,
      JSON.stringify(state.participants.map((p) => p.score)),
      // tally is absent until the question closes, so it cannot be read
      // unguarded here.
      state.current && state.current.tally ? state.current.tally.join(',') : '',
    ].join('|');
    if (key === renderedKey) return;
    renderedKey = key;

    TQ.clear(main);
    if (quiz.status === 'finished') main.append(finishedView());
    else if (state.current) main.append(runningView());
    else main.append(lobbyView());
  }

  async function refresh() {
    const next = await TQ.get(`/api/quizzes/${code}/host`, authHeader());
    TQ.clock.sync(next.serverTime);
    state = next;
    render();
  }

  function askForToken() {
    TQ.clear(main);
    const fragment = TQ.$('#tpl-token').content.cloneNode(true);
    main.append(fragment);
    const form = TQ.$('#token-form', main);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = TQ.$('#token-input', main).value.trim();
      if (!value) return;
      hostToken = value;
      TQ.store.set(`tq.host.${code}`, value);
      renderedKey = '';
      start();
    });
  }

  let poller = null;

  async function start() {
    // Without a host token this tab drives the quiz on the admin session, which
    // needs a CSRF token. Fetch one in case this tab was opened fresh and has
    // nothing in sessionStorage.
    if (!hostToken && !TQ.csrf()) {
      try {
        const session = await TQ.get('/api/admin/session');
        if (session.authenticated && session.csrfToken) TQ.setCsrf(session.csrfToken);
      } catch {
        /* not signed in; the host-token prompt below will handle it */
      }
    }

    try {
      await refresh();
    } catch (error) {
      if (error.status === 403 || error.status === 401) {
        askForToken();
        return;
      }
      TQ.clear(main);
      main.append(TQ.el('div', { class: 'notice notice--error', text: error.message }));
      return;
    }
    if (poller) poller.stop();
    poller = TQ.poll(refresh, 1500);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && poller) poller.now();
  });

  window.addEventListener('pagehide', () => {
    if (poller) poller.stop();
    stopTimer();
  });

  start();
})();
