'use strict';

(() => {
  const EXAMPLE = `# Week 3 — Ranked retrieval

## Question 1
**Time:** 20
**Topic:** Retrieval
**Difficulty:** easy

In a term-document incidence matrix, what does a 1 in row *calpurnia*, column *Hamlet* mean?

- [ ] The term is the most frequent word in the play
- [x] The term occurs somewhere in the play
- [ ] The term occurs exactly once in the play
- [ ] The play is the top result for the query

## Question 2
**Time:** 30
**Topic:** Retrieval
**Difficulty:** medium
**Reveal:** slow

Why is inverse document frequency used alongside term frequency?

- [ ] It makes the index smaller
- [ ] It speeds up posting-list intersection
- [x] It reduces the weight of terms that appear in many documents
- [ ] It normalises for document length

## Question 3
**Time:** 25
**Topic:** Evaluation
**Difficulty:** hard
**Show ranking:** no

A system returns 10 documents, 4 of which are relevant, out of 20 relevant documents in the collection. What are precision and recall?

- [x] Precision 0.4, recall 0.2
- [ ] Precision 0.2, recall 0.4
- [ ] Precision 0.4, recall 0.4
- [ ] Precision 0.2, recall 0.2
`;

  // --- state ----------------------------------------------------------------

  let bankQuestions = [];
  const selected = new Set();
  let topics = [];

  // --- session guard --------------------------------------------------------

  async function guard() {
    try {
      const session = await TQ.get('/api/admin/session');
      if (!session.authenticated) {
        window.location.replace('/admin');
        return false;
      }
      if (session.mustChangePassword) {
        window.location.replace('/admin');
        return false;
      }
      // A tab opened directly at this URL, or reopened after the browser was
      // restarted, has the session cookie but an empty sessionStorage. Taking
      // the token from the session check is what stops every action 403-ing.
      if (session.csrfToken) TQ.setCsrf(session.csrfToken);
      TQ.$('#who').textContent = session.username;
      TQ.$('#set-user').value = session.username;
      return true;
    } catch {
      window.location.replace('/admin');
      return false;
    }
  }

  TQ.$('#signout').addEventListener('click', async () => {
    try {
      await TQ.post('/api/admin/logout');
    } catch { /* signing out locally regardless */ }
    TQ.setCsrf('');
    window.location.href = '/admin';
  });

  // --- tabs -----------------------------------------------------------------

  const TAB_LOADERS = {
    bank: () => { loadBank(); loadTopics(); },
    quizzes: loadQuizzes,
    settings: () => { loadHealth(); loadBackups(); },
  };

  TQ.$$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  });

  function selectTab(name) {
    TQ.$$('.tab').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    });
    for (const key of ['new', 'bank', 'quizzes', 'settings']) {
      TQ.show(TQ.$(`#tab-${key}`), key === name);
    }
    // Keep the tab in the URL so a reload lands back where you were.
    history.replaceState(null, '', `#${name}`);
    if (TAB_LOADERS[name]) TAB_LOADERS[name]();
  }

  // --- shared: modal --------------------------------------------------------

  function modal(title, bodyNodes, actions) {
    const dialog = TQ.el('dialog', {
      style: 'border:1px solid var(--rule);border-radius:8px;padding:0;max-width:680px;width:calc(100vw - 2rem);box-shadow:var(--shadow-lg);background:var(--surface)',
    }, [
      TQ.el('div', { class: 'panel__head' }, [TQ.el('h3', { text: title })]),
      TQ.el('div', { class: 'panel__body', style: 'max-height:70vh;overflow:auto' }, bodyNodes),
      TQ.el('div', { class: 'panel__foot row row--end' }, actions(() => {
        dialog.close();
        dialog.remove();
      })),
    ]);
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
    return dialog;
  }

  function errorNotes(error) {
    const nodes = [TQ.el('div', { class: 'notice notice--error', text: error.message })];
    const notes = error.details && error.details.errors;
    if (notes) {
      nodes.push(TQ.el('ul', { class: 'notes', style: 'margin-top:.5rem' },
        notes.map((n) => TQ.el('li', {}, [
          TQ.el('span', { class: 'notes__line', text: `L${n.line}` }),
          TQ.el('span', { text: n.message }),
        ]))));
    }
    return nodes;
  }

  // ==========================================================================
  // New quiz
  // ==========================================================================

  const editor = TQ.$('#editor');
  const validation = TQ.$('#validation');
  const validFlag = TQ.$('#valid-flag');
  let validateTimer = null;
  let lastValid = null;

  TQ.$('#load-example').addEventListener('click', () => {
    editor.value = EXAMPLE;
    scheduleValidate();
    editor.focus();
  });

  TQ.$('#clear-editor').addEventListener('click', () => {
    editor.value = '';
    scheduleValidate();
    editor.focus();
  });

  editor.addEventListener('input', scheduleValidate);

  function scheduleValidate() {
    clearTimeout(validateTimer);
    // Debounced so a fast typist does not trigger a request per keystroke.
    validateTimer = setTimeout(validate, 350);
  }

  async function validate() {
    const markdown = editor.value.trim();
    TQ.clear(validFlag);
    if (!markdown) {
      lastValid = null;
      TQ.clear(validation).append(TQ.el('p', { class: 'empty', style: 'padding:1rem 0', text: 'Start typing to see notes here.' }));
      return;
    }

    try {
      const result = await TQ.post('/api/quizzes/validate', { markdown });
      lastValid = result;
      TQ.clear(validation);

      validFlag.append(TQ.el('span', {
        class: `badge badge--${result.ok ? 'available' : 'used'}`,
        text: result.ok ? 'valid' : `${result.errors.length} problem${result.errors.length === 1 ? '' : 's'}`,
      }));

      if (result.ok) {
        validation.append(TQ.el('div', { class: 'notice notice--ok' }, [
          TQ.el('strong', { text: `${result.questionCount} question${result.questionCount === 1 ? '' : 's'}` }),
          ` · about ${Math.round(result.totalSeconds / 60)} min of question time`,
        ]));
        if (result.title) TQ.$('#quiz-name').placeholder = result.title;
      } else {
        validation.append(TQ.el('ul', { class: 'notes' },
          result.errors.map((n) => TQ.el('li', {}, [
            TQ.el('span', { class: 'notes__line', text: `L${n.line}` }),
            TQ.el('span', { text: n.message }),
          ]))));
      }

      // The whole point of the bank: warn before a class is asked something twice.
      const reuse = result.reuse || [];
      const repeats = reuse.filter((entry) => entry.used);
      const reserved = reuse.filter((entry) => !entry.used && entry.status === 'reserved');
      const retired = reuse.filter((entry) => entry.retired);

      if (repeats.length) {
        validation.append(TQ.el('div', { class: 'notice notice--error', style: 'margin-top:.7rem' }, [
          TQ.el('strong', { text: `${repeats.length} question${repeats.length === 1 ? ' has' : 's have'} already been asked in class` }),
          TQ.el('ul', { style: 'margin:.4rem 0 0;padding-left:1.1rem' },
            repeats.map((entry) => {
              const when = entry.history && entry.history[0];
              return TQ.el('li', { class: 'small',
                text: `Question ${entry.position} — previously in “${when ? when.quiz_name : 'an earlier quiz'}”${when ? ` on ${TQ.dateOnly(when.used_at)}` : ''}` });
            })),
        ]));
      }

      // Not yet shown to anyone, but already committed to a quiz that has not
      // run. Releasing both would still repeat the question.
      if (reserved.length) {
        validation.append(TQ.el('div', { class: 'notice notice--warn', style: 'margin-top:.7rem' }, [
          TQ.el('strong', { text: `${reserved.length} question${reserved.length === 1 ? ' is' : 's are'} already in another quiz waiting to run` }),
          TQ.el('p', { class: 'small', style: 'margin:.3rem 0 0',
            text: `Question${reserved.length === 1 ? ' ' : 's '}${reserved.map((e) => e.position).join(', ')} — running both quizzes would ask the same thing twice.` }),
        ]));
      }

      if (retired.length) {
        validation.append(TQ.el('div', { class: 'notice notice--warn', style: 'margin-top:.7rem' }, [
          TQ.el('strong', { text: `${retired.length} question${retired.length === 1 ? ' was' : 's were'} retired from the bank` }),
          TQ.el('p', { class: 'small', style: 'margin:.3rem 0 0',
            text: `Question${retired.length === 1 ? ' ' : 's '}${retired.map((e) => e.position).join(', ')} — retired usually means it was withdrawn for a reason.` }),
        ]));
      }
    } catch (error) {
      TQ.clear(validation).append(...errorNotes(error));
    }
  }

  TQ.$('#create-quiz').addEventListener('click', async (event) => {
    const markdown = editor.value.trim();
    if (!markdown) {
      TQ.toast('Write or paste a quiz first.', 'error');
      return;
    }
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Creating…';
    try {
      const result = await TQ.post('/api/quizzes', {
        markdown,
        name: TQ.$('#quiz-name').value.trim() || undefined,
        addToBank: TQ.$('#add-to-bank').checked,
      });
      showCreated(result);
      editor.value = '';
      TQ.$('#quiz-name').value = '';
      scheduleValidate();
    } catch (error) {
      TQ.clear(validation).append(...errorNotes(error));
      TQ.fail(error);
    } finally {
      button.disabled = false;
      button.textContent = 'Create quiz and open the lobby';
    }
  });

  /**
   * Renders a secret without putting it on screen. The console is often on the
   * same projector as the quiz, so anything sensitive stays masked until the
   * instructor deliberately reveals it.
   */
  function secretField(secret, note) {
    const field = TQ.el('input', {
      type: 'password',
      readonly: true,
      value: secret,
      'aria-label': 'Host token',
      style: 'font-family:var(--mono);font-size:.75rem',
    });

    const reveal = TQ.el('button', {
      class: 'btn btn--sm', type: 'button',
      onclick: () => {
        const showing = field.type === 'text';
        field.type = showing ? 'password' : 'text';
        reveal.textContent = showing ? 'Reveal' : 'Hide';
      },
    }, ['Reveal']);

    const copy = TQ.el('button', {
      class: 'btn btn--sm btn--primary', type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(secret);
          TQ.toast('Copied to the clipboard.', 'ok');
        } catch {
          field.type = 'text';
          reveal.textContent = 'Hide';
          TQ.toast('Clipboard blocked — the token is now visible, so copy it by hand.', 'error', 7000);
        }
      },
    }, ['Copy']);

    return TQ.el('div', {}, [
      TQ.el('div', { class: 'row row--tight' }, [field, copy, reveal]),
      TQ.el('p', { class: 'hint', text: note }),
    ]);
  }

  function showCreated(result) {
    // Kept in this tab's session storage so the host screen works immediately.
    // It is deliberately never rendered: this panel is often already on the
    // projector by the time a quiz is created. Anyone who genuinely needs the
    // token for a script can issue a fresh one from the Quizzes tab.
    TQ.store.set(`tq.host.${result.code}`, result.hostToken);

    const body = TQ.clear(TQ.$('#created-body'));
    body.append(
      TQ.el('p', { class: 'eyebrow', text: 'Room code' }),
      TQ.el('p', { class: 'roomcode', style: 'font-size:2.2rem;text-align:center;margin:.2rem 0 1rem', text: result.code }),
      TQ.el('p', { class: 'hint', style: 'text-align:center;margin:0 0 1rem',
        text: 'Saved. Nobody can join until you open the room on the host screen, so you can leave this and come back on the day.' }),
      TQ.el('a', { class: 'btn btn--go btn--block', href: `/host/${result.code}` }, ['Open the host screen']),
    );
    TQ.show(TQ.$('#created-panel'), true);
    TQ.$('#created-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ==========================================================================
  // Question bank
  // ==========================================================================

  const bankFilters = ['#bank-search', '#bank-topic', '#bank-status', '#bank-difficulty'];
  let bankTimer = null;
  bankFilters.forEach((selector) => {
    const node = TQ.$(selector);
    node.addEventListener(node.tagName === 'SELECT' ? 'change' : 'input', () => {
      clearTimeout(bankTimer);
      bankTimer = setTimeout(loadBank, node.tagName === 'SELECT' ? 0 : 300);
    });
  });

  async function loadTopics() {
    try {
      const result = await TQ.get('/api/bank/topics');
      topics = result.topics;
      for (const id of ['#bank-topic', '#draw-topic']) {
        const select = TQ.$(id);
        const current = select.value;
        TQ.clear(select);
        select.append(TQ.el('option', { value: '', text: id === '#draw-topic' ? 'Any topic' : 'All topics' }));
        topics.forEach((topic) => {
          select.append(TQ.el('option', {
            value: topic.name,
            text: `${topic.name} (${topic.fresh} fresh / ${topic.total})`,
          }));
        });
        select.value = current;
      }
    } catch (error) {
      TQ.fail(error);
    }
  }

  async function loadBank() {
    const params = new URLSearchParams();
    const search = TQ.$('#bank-search').value.trim();
    if (search) params.set('search', search);
    if (TQ.$('#bank-topic').value) params.set('topic', TQ.$('#bank-topic').value);
    if (TQ.$('#bank-status').value) params.set('status', TQ.$('#bank-status').value);
    if (TQ.$('#bank-difficulty').value) params.set('difficulty', TQ.$('#bank-difficulty').value);
    if (TQ.$('#bank-status').value === 'retired') params.set('includeRetired', 'true');

    const list = TQ.$('#bank-list');
    try {
      const result = await TQ.get(`/api/bank/questions?${params}`);
      bankQuestions = result.questions;
      renderStats(result.stats);
      renderBank(result.questions, result.total);
    } catch (error) {
      TQ.clear(list).append(TQ.el('div', { class: 'notice notice--error', text: error.message }));
    }
  }

  function renderStats(stats) {
    const host = TQ.clear(TQ.$('#bank-stats'));
    const tile = (value, label, mod) => TQ.el('div', { class: `stat${mod ? ` stat--${mod}` : ''}` }, [
      TQ.el('div', { class: 'stat__value', text: value }),
      TQ.el('div', { class: 'stat__label', text: label }),
    ]);
    host.append(
      tile(stats.total, 'In the bank'),
      tile(stats.available, 'Never used', 'available'),
      tile(stats.reserved, 'Reserved', 'reserved'),
      tile(stats.used, 'Already used', 'used'),
      tile(stats.retired, 'Retired'),
    );
  }

  function renderBank(questions, total) {
    const list = TQ.clear(TQ.$('#bank-list'));
    if (!questions.length) {
      list.append(TQ.el('p', { class: 'empty', text: 'No questions match those filters.' }));
      updateSelectionCount();
      return;
    }

    questions.forEach((question) => {
      const canPick = question.status === 'available' || TQ.$('#allow-used').checked;
      const checkbox = TQ.el('input', {
        class: 'bankitem__pick',
        type: 'checkbox',
        checked: selected.has(question.id),
        'aria-label': `Select: ${question.prompt.slice(0, 60)}`,
        onchange: (event) => {
          if (event.target.checked) selected.add(question.id);
          else selected.delete(question.id);
          updateSelectionCount();
        },
      });

      const options = TQ.el('ul', { class: 'opts' }, question.options.map((option, index) => TQ.el('li', {
        class: index === question.answerIndex ? 'is-correct' : '',
      }, [
        TQ.el('span', { class: 'opts__key', text: TQ.letter(index) }),
        TQ.el('span', { text: option.text }),
      ])));

      list.append(TQ.el('div', { class: 'bankitem' }, [
        checkbox,
        TQ.el('div', { class: 'bankitem__body' }, [
          TQ.el('div', { class: 'bankitem__prompt', text: question.prompt }),
          options,
          TQ.el('div', { class: 'bankitem__meta' }, [
            TQ.el('span', { class: `badge badge--${question.status}`, text: question.status }),
            TQ.el('span', { class: `badge badge--${question.difficulty}`, text: question.difficulty }),
            TQ.el('span', { class: 'tiny muted', text: question.topic }),
            TQ.el('span', { class: 'tiny muted', text: `${question.timeLimit}s` }),
            question.useCount > 0
              ? TQ.el('span', { class: 'tiny muted', text: `used ${question.useCount}× · last ${TQ.dateOnly(question.lastUsedAt)}` })
              : null,
          ]),
        ]),
        TQ.el('div', { class: 'bankitem__actions' }, [
          TQ.el('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => editQuestion(question) }, ['Edit']),
          TQ.el('button', {
            class: 'btn btn--sm btn--ghost', type: 'button',
            onclick: () => toggleRetire(question),
          }, [question.retired ? 'Restore' : 'Retire']),
          question.useCount === 0
            ? TQ.el('button', {
                class: 'btn btn--sm btn--ghost btn--danger', type: 'button',
                onclick: () => removeQuestion(question),
              }, ['Delete'])
            : null,
        ]),
      ]));
    });

    if (total > questions.length) {
      list.append(TQ.el('p', { class: 'empty tiny', text: `Showing ${questions.length} of ${total}. Narrow the filters to see the rest.` }));
    }
    updateSelectionCount();
  }

  function updateSelectionCount() {
    const node = TQ.$('#selection-count');
    node.textContent = selected.size === 0
      ? 'Nothing selected.'
      : `${selected.size} question${selected.size === 1 ? '' : 's'} selected.`;
  }

  async function toggleRetire(question) {
    try {
      await TQ.post(`/api/bank/questions/${question.id}/retire`, { retired: !question.retired });
      TQ.toast(question.retired ? 'Question restored.' : 'Question retired — it will not be offered again.', 'ok');
      loadBank();
    } catch (error) {
      TQ.fail(error);
    }
  }

  async function removeQuestion(question) {
    if (!window.confirm('Delete this question from the bank? This cannot be undone.')) return;
    try {
      await TQ.del(`/api/bank/questions/${question.id}`);
      selected.delete(question.id);
      TQ.toast('Question deleted.', 'ok');
      loadBank();
      loadTopics();
    } catch (error) {
      TQ.fail(error);
    }
  }

  /** Shared editor for creating and updating a bank question. */
  function editQuestion(question) {
    const isNew = !question;
    const data = question || {
      topic: '', difficulty: 'medium', prompt: '', timeLimit: 20,
      reveal: 'show', showRanking: true, imageUrl: '', imageAlt: '',
      options: [{ text: '' }, { text: '' }, { text: '' }, { text: '' }],
      answerIndex: 0,
    };

    const prompt = TQ.el('textarea', { style: 'min-height:80px', text: data.prompt });
    const topic = TQ.el('input', { type: 'text', value: data.topic || '', placeholder: 'General', list: 'topic-options' });
    const topicList = TQ.el('datalist', { id: 'topic-options' }, topics.map((t) => TQ.el('option', { value: t.name })));
    const difficulty = TQ.el('select', {}, ['easy', 'medium', 'hard'].map((d) =>
      TQ.el('option', { value: d, text: d, selected: data.difficulty === d })));
    const timeLimit = TQ.el('input', { type: 'number', min: 10, max: 600, value: data.timeLimit });
    const reveal = TQ.el('select', {}, [
      TQ.el('option', { value: 'show', text: 'show — reveal immediately', selected: data.reveal === 'show' }),
      TQ.el('option', { value: 'slow', text: 'slow — hold before revealing', selected: data.reveal === 'slow' }),
    ]);
    const showRanking = TQ.el('input', { type: 'checkbox', checked: data.showRanking !== false });
    const imageUrl = TQ.el('input', { type: 'text', value: data.imageUrl || '', placeholder: 'https://… (optional)' });
    const imageAlt = TQ.el('input', { type: 'text', value: data.imageAlt || '', placeholder: 'Describe the image' });

    const optionRows = TQ.el('div', { class: 'stack', style: '--gap:.45rem' });
    const radios = [];

    function addOption(text = '', correct = false) {
      if (optionRows.children.length >= 6) return;
      const index = optionRows.children.length;
      const radio = TQ.el('input', { type: 'radio', name: 'correct-option', checked: correct, style: 'width:auto;flex:none' });
      const input = TQ.el('input', { type: 'text', value: text, placeholder: `Option ${TQ.letter(index)}` });
      const row = TQ.el('div', { class: 'row row--tight' }, [
        radio,
        TQ.el('span', { class: 'opts__key', style: 'width:1.2rem', text: TQ.letter(index) }),
        input,
        TQ.el('button', {
          class: 'btn btn--sm btn--ghost', type: 'button', title: 'Remove this option',
          onclick: () => {
            if (optionRows.children.length <= 4) {
              TQ.toast('A question needs at least four options.', 'error');
              return;
            }
            const position = radios.findIndex((entry) => entry.row === row);
            if (position !== -1) radios.splice(position, 1);
            row.remove();
            relabel();
          },
        }, ['×']),
      ]);
      radios.push({ radio, input, row });
      optionRows.append(row);
    }

    function relabel() {
      Array.from(optionRows.children).forEach((row, index) => {
        row.children[1].textContent = TQ.letter(index);
        row.children[2].placeholder = `Option ${TQ.letter(index)}`;
      });
    }

    data.options.forEach((option, index) => addOption(option.text, index === data.answerIndex));

    const errorBox = TQ.el('div');

    modal(isNew ? 'New question' : 'Edit question', [
      TQ.el('div', { class: 'field' }, [TQ.el('label', { text: 'Question text' }), prompt]),
      TQ.el('div', { class: 'split--even', style: 'display:grid;gap:.9rem' }, [
        TQ.el('div', { class: 'field' }, [TQ.el('label', { text: 'Topic' }), topic, topicList]),
        TQ.el('div', { class: 'field' }, [TQ.el('label', { text: 'Difficulty' }), difficulty]),
        TQ.el('div', { class: 'field' }, [TQ.el('label', { text: 'Time limit (seconds)' }), timeLimit]),
        TQ.el('div', { class: 'field' }, [TQ.el('label', { text: 'Reveal' }), reveal]),
      ]),
      TQ.el('label', { class: 'check' }, [showRanking, TQ.el('span', { text: 'Show rankings to students after this question' })]),
      TQ.el('hr', { class: 'divider' }),
      TQ.el('p', { class: 'eyebrow', text: 'Answer options — select the correct one' }),
      optionRows,
      TQ.el('button', {
        class: 'btn btn--sm', type: 'button', style: 'margin-top:.5rem',
        onclick: () => { addOption(); relabel(); },
      }, ['Add option']),
      TQ.el('hr', { class: 'divider' }),
      TQ.el('div', { class: 'field' }, [TQ.el('label', { text: 'Image URL (optional)' }), imageUrl]),
      TQ.el('div', { class: 'field' }, [TQ.el('label', { text: 'Image alt text' }), imageAlt]),
      errorBox,
    ], (close) => [
      TQ.el('button', { class: 'btn', type: 'button', onclick: close }, ['Cancel']),
      TQ.el('button', {
        class: 'btn btn--primary', type: 'button',
        onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          TQ.clear(errorBox);
          const options = radios.map((entry) => ({ text: entry.input.value.trim() }));
          const answerIndex = radios.findIndex((entry) => entry.radio.checked);
          const payload = {
            prompt: prompt.value,
            topic: topic.value.trim() || 'General',
            difficulty: difficulty.value,
            timeLimit: Number(timeLimit.value),
            reveal: reveal.value,
            showRanking: showRanking.checked,
            imageUrl: imageUrl.value.trim(),
            imageAlt: imageAlt.value.trim(),
            options,
            answerIndex: answerIndex === -1 ? 0 : answerIndex,
          };
          try {
            if (isNew) await TQ.post('/api/bank/questions', payload);
            else await TQ.patch(`/api/bank/questions/${question.id}`, payload);
            TQ.toast(isNew ? 'Question added to the bank.' : 'Question updated.', 'ok');
            close();
            loadBank();
            loadTopics();
          } catch (error) {
            errorBox.append(...errorNotes(error));
          } finally {
            button.disabled = false;
          }
        },
      }, [isNew ? 'Add to bank' : 'Save changes']),
    ]);
  }

  TQ.$('#bank-new').addEventListener('click', () => editQuestion(null));

  TQ.$('#bank-import').addEventListener('click', () => {
    const textarea = TQ.el('textarea', {
      class: 'code',
      style: 'min-height:260px',
      placeholder: '## Question 1\n**Time:** 20\n**Topic:** Retrieval\n\nQuestion text\n\n- [x] Correct\n- [ ] Wrong\n- [ ] Wrong\n- [ ] Wrong',
    });
    const topicInput = TQ.el('input', { type: 'text', placeholder: 'Default topic for questions without one' });
    const errorBox = TQ.el('div');

    modal('Import questions into the bank', [
      TQ.el('p', { class: 'hint', style: 'margin-top:0', text: 'Paste "## Question" blocks. A "#" title line is optional. Questions already in the bank are skipped rather than duplicated.' }),
      TQ.el('div', { class: 'field' }, [TQ.el('label', { text: 'Default topic' }), topicInput]),
      textarea,
      errorBox,
    ], (close) => [
      TQ.el('button', { class: 'btn', type: 'button', onclick: close }, ['Cancel']),
      TQ.el('button', {
        class: 'btn btn--primary', type: 'button',
        onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          TQ.clear(errorBox);
          try {
            const result = await TQ.post('/api/bank/import', {
              markdown: textarea.value,
              topic: topicInput.value.trim() || undefined,
            });
            const skipped = result.duplicates.length;
            TQ.toast(`Added ${result.added} question${result.added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} already in the bank` : ''}.`, 'ok');
            close();
            loadBank();
            loadTopics();
          } catch (error) {
            errorBox.append(...errorNotes(error));
          } finally {
            button.disabled = false;
          }
        },
      }, ['Import']),
    ]);
  });

  TQ.$('#bank-export').addEventListener('click', (event) => {
    const topic = TQ.$('#bank-topic').value;
    event.currentTarget.href = topic
      ? `/api/bank/export?topic=${encodeURIComponent(topic)}`
      : '/api/bank/export';
  });

  TQ.$('#draw-btn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await TQ.post('/api/bank/draw', {
        count: Number(TQ.$('#draw-count').value) || 5,
        topic: TQ.$('#draw-topic').value || undefined,
        difficulty: TQ.$('#draw-difficulty').value || undefined,
      });
      selected.clear();
      result.questions.forEach((question) => selected.add(question.id));
      if (result.shortfall > 0) {
        TQ.toast(`Only ${result.questions.length} unused question${result.questions.length === 1 ? '' : 's'} available — ${result.shortfall} short. Add more to the bank.`, 'error', 6500);
      } else {
        TQ.toast(`Drew ${result.questions.length} fresh questions.`, 'ok');
      }
      // Show exactly what was drawn.
      TQ.$('#bank-status').value = '';
      TQ.$('#bank-search').value = '';
      await loadBank();
    } catch (error) {
      TQ.fail(error);
    } finally {
      button.disabled = false;
    }
  });

  TQ.$('#allow-used').addEventListener('change', loadBank);

  TQ.$('#build-from-bank').addEventListener('click', async (event) => {
    if (selected.size === 0) {
      TQ.toast('Tick some questions first, or draw a random set.', 'error');
      return;
    }
    const name = TQ.$('#bank-quiz-name').value.trim();
    if (!name) {
      TQ.toast('Give the quiz a title.', 'error');
      TQ.$('#bank-quiz-name').focus();
      return;
    }

    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Creating…';
    try {
      const result = await TQ.post('/api/quizzes', {
        name,
        questionIds: Array.from(selected),
        allowUsed: TQ.$('#allow-used').checked,
      });
      selected.clear();
      TQ.$('#bank-quiz-name').value = '';
      showCreated(result);
      selectTab('new');
      loadBank();
    } catch (error) {
      TQ.fail(error);
    } finally {
      button.disabled = false;
      button.textContent = 'Create quiz from selection';
    }
  });

  // ==========================================================================
  // Quizzes
  // ==========================================================================

  TQ.$('#quiz-filter').addEventListener('change', loadQuizzes);

  /** A prepared quiz is being set up for later; an open one is being hosted. */
  function buttonLabel(quiz) {
    if (quiz.status === 'finished') return 'Review';
    if (quiz.displayStatus === 'prepared') return 'Set up';
    return 'Host';
  }

  async function loadQuizzes() {
    const status = TQ.$('#quiz-filter').value;
    const host = TQ.$('#quiz-list');
    try {
      const result = await TQ.get(`/api/admin/quizzes${status ? `?status=${status}` : ''}`);
      TQ.clear(host);
      if (!result.quizzes.length) {
        host.append(TQ.el('p', { class: 'empty', text: 'No quizzes yet. Write one on the “New quiz” tab.' }));
        return;
      }

      host.append(TQ.el('table', { class: 'table' }, [
        TQ.el('thead', {}, [TQ.el('tr', {}, [
          TQ.el('th', { text: 'Quiz' }),
          TQ.el('th', { text: 'Code' }),
          TQ.el('th', { text: 'Status' }),
          TQ.el('th', { text: 'Created' }),
          TQ.el('th', { class: 'num', text: 'Qs' }),
          TQ.el('th', { class: 'num', text: 'Students' }),
          TQ.el('th', { text: '' }),
        ])]),
        TQ.el('tbody', {}, result.quizzes.map((quiz) => TQ.el('tr', {}, [
          TQ.el('td', {}, [
            TQ.el('div', { style: 'font-weight:600', text: quiz.name }),
            quiz.archivePath ? TQ.el('div', { class: 'tiny muted', text: quiz.archivePath }) : null,
          ]),
          TQ.el('td', {}, [TQ.el('code', { text: quiz.code })]),
          TQ.el('td', {}, [TQ.el('span', {
            class: `badge badge--${quiz.displayStatus || quiz.status}`,
            text: quiz.displayStatus || quiz.status,
          })]),
          TQ.el('td', { class: 'small muted nowrap', text: TQ.dateTime(quiz.createdAt) }),
          TQ.el('td', { class: 'num tnum', text: quiz.questionCount }),
          TQ.el('td', { class: 'num tnum', text: quiz.participantCount }),
          TQ.el('td', {}, [
            TQ.el('div', { class: 'row row--tight row--end nowrap' }, [
              TQ.el('a', {
                class: `btn btn--sm${quiz.displayStatus === 'prepared' ? ' btn--primary' : ''}`,
                href: `/host/${quiz.code}`,
                title: quiz.displayStatus === 'prepared'
                  ? 'Open the host screen; the room stays shut until you open it there'
                  : '',
              }, [buttonLabel(quiz)]),
              TQ.el('button', {
                class: 'btn btn--sm btn--ghost', type: 'button', title: 'Download the full JSON record',
                onclick: () => TQ.download(`/api/quizzes/${quiz.code}/export`, { format: 'json' }, `${quiz.code}.json`).catch(TQ.fail),
              }, ['JSON']),
              TQ.el('button', {
                class: 'btn btn--sm btn--ghost', type: 'button', title: 'Issue a replacement host token',
                onclick: () => reissueToken(quiz),
              }, ['Token']),
              TQ.el('button', {
                class: 'btn btn--sm btn--ghost btn--danger', type: 'button',
                onclick: () => deleteQuiz(quiz),
              }, ['Delete']),
            ]),
          ]),
        ]))),
      ]));
    } catch (error) {
      TQ.clear(host).append(TQ.el('div', { class: 'notice notice--error', text: error.message }));
    }
  }

  async function reissueToken(quiz) {
    if (!window.confirm(`Issue a new host token for “${quiz.name}”? Any device using the old token will stop working.`)) return;
    try {
      const result = await TQ.post(`/api/admin/quizzes/${quiz.id}/host-token`);
      TQ.store.set(`tq.host.${quiz.code}`, result.hostToken);
      modal('New host token', [
        TQ.el('p', { class: 'small muted', text: 'Copy this now — it is not stored anywhere you can read it again. The old token has stopped working.' }),
        secretField(result.hostToken, 'Kept hidden in case this screen is being projected.'),
      ], (close) => [TQ.el('button', { class: 'btn btn--primary', type: 'button', onclick: close }, ['Done'])]);
    } catch (error) {
      TQ.fail(error);
    }
  }

  async function deleteQuiz(quiz) {
    if (!window.confirm(`Delete “${quiz.name}” and all of its answers?\n\nQuestions it used stay marked as used in the bank, so they will not be asked again.`)) return;
    const alsoArchive = window.confirm('Also delete the JSON record on disk?\n\nOK deletes it. Cancel keeps the file.');
    try {
      await TQ.del(`/api/admin/quizzes/${quiz.id}${alsoArchive ? '?archive=delete' : ''}`);
      TQ.toast('Quiz deleted.', 'ok');
      loadQuizzes();
    } catch (error) {
      TQ.fail(error);
    }
  }

  // ==========================================================================
  // Settings
  // ==========================================================================

  TQ.$('#cred-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const box = TQ.clear(TQ.$('#cred-error'));
    const password = TQ.$('#set-pass').value;
    if (password !== TQ.$('#set-pass2').value) {
      box.append(TQ.el('div', { class: 'notice notice--error', text: 'The two new passwords do not match.' }));
      return;
    }
    try {
      const result = await TQ.post('/api/admin/credentials', {
        currentPassword: TQ.$('#cur-pass').value,
        username: TQ.$('#set-user').value.trim(),
        newPassword: password,
      });
      TQ.setCsrf(result.csrfToken);
      TQ.$('#cur-pass').value = '';
      TQ.$('#set-pass').value = '';
      TQ.$('#set-pass2').value = '';
      TQ.$('#who').textContent = result.username;
      TQ.toast('Credentials updated. Other devices have been signed out.', 'ok');
    } catch (error) {
      box.append(TQ.el('div', { class: 'notice notice--error', text: error.message }));
    }
  });

  TQ.$('#health-refresh').addEventListener('click', loadHealth);

  async function loadHealth() {
    const host = TQ.$('#health');
    try {
      const h = await TQ.get('/api/admin/health');
      TQ.clear(host);
      const row = (label, value, ok) => TQ.el('div', {
        class: 'row row--between',
        style: 'border-bottom:1px solid var(--rule);padding:.35rem 0',
      }, [
        TQ.el('span', { class: 'small muted', text: label }),
        TQ.el('span', { class: `small tnum${ok === false ? '' : ''}`, style: ok === false ? 'color:var(--red);font-weight:650' : 'font-weight:600', text: value }),
      ]);

      host.append(
        row('Database integrity', h.integrity, h.integrity === 'ok'),
        row('Quizzes', String(h.counts.quizzes)),
        row('Running now', String(h.counts.running)),
        row('Bank questions', String(h.counts.bankQuestions)),
        row('Participants recorded', String(h.counts.participants)),
        row('Answers recorded', String(h.counts.answers)),
        row('JSON records on disk', String(h.archives)),
        row('Backups kept', `${h.backups.count} (every ${h.backups.intervalMinutes} min, keep ${h.backups.keep})`),
        row('Active sign-ins', String(h.counts.sessions)),
        row('Server uptime', TQ.seconds(h.uptimeSeconds)),
        row('Node', h.nodeVersion),
      );
    } catch (error) {
      TQ.clear(host).append(TQ.el('div', { class: 'notice notice--error', text: error.message }));
    }
  }

  async function loadBackups() {
    const host = TQ.$('#backup-list');
    try {
      const result = await TQ.get('/api/admin/backups');
      TQ.clear(host);
      if (!result.backups.length) {
        host.append(TQ.el('p', { class: 'empty', text: 'No backups yet.' }));
        return;
      }
      host.append(TQ.el('table', { class: 'table' }, [
        TQ.el('thead', {}, [TQ.el('tr', {}, [
          TQ.el('th', { text: 'Snapshot' }),
          TQ.el('th', { class: 'num', text: 'Size' }),
          TQ.el('th', { text: 'Taken' }),
        ])]),
        TQ.el('tbody', {}, result.backups.slice(0, 12).map((b) => TQ.el('tr', {}, [
          TQ.el('td', {}, [TQ.el('code', { class: 'tiny', text: b.name })]),
          TQ.el('td', { class: 'num small muted', text: TQ.bytes(b.bytes) }),
          TQ.el('td', { class: 'small muted nowrap', text: TQ.dateTime(b.modified) }),
        ]))),
      ]));
    } catch (error) {
      TQ.clear(host).append(TQ.el('div', { class: 'notice notice--error', text: error.message }));
    }
  }

  TQ.$('#backup-now').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await TQ.post('/api/admin/backup');
      TQ.toast('Snapshot taken.', 'ok');
      loadBackups();
      loadHealth();
    } catch (error) {
      TQ.fail(error);
    } finally {
      button.disabled = false;
    }
  });

  TQ.$$('[data-maint]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await TQ.post('/api/admin/maintenance', { action: button.dataset.maint });
        const removed = Array.isArray(result.removed) ? result.removed.length : result.removed;
        TQ.toast(`Done — ${removed} removed.`, 'ok');
        loadBackups();
        loadHealth();
      } catch (error) {
        TQ.fail(error);
      } finally {
        button.disabled = false;
      }
    });
  });

  TQ.$('#revoke-all').addEventListener('click', async () => {
    if (!window.confirm('Sign out every other signed-in device? You will stay signed in here.')) return;
    try {
      const result = await TQ.post('/api/admin/sessions/revoke');
      TQ.setCsrf(result.csrfToken);
      TQ.toast('All other devices signed out.', 'ok');
      loadHealth();
    } catch (error) {
      TQ.fail(error);
    }
  });

  // --- boot -----------------------------------------------------------------

  (async () => {
    if (!(await guard())) return;
    const wanted = (window.location.hash || '#new').slice(1);
    selectTab(['new', 'bank', 'quizzes', 'settings'].includes(wanted) ? wanted : 'new');
  })();
})();
