/* Ticket UI shares fetchJson and navigation with barplot.js. All user content uses text nodes. */
window.ticketDashboard = (() => {
  const $ = (id) => document.getElementById(id);
  const names = {
    OPEN: 'Open', IN_PROGRESS: 'In progress', WAITING: 'Waiting', RESOLVED: 'Resolved', CANCELLED: 'Cancelled',
    USER_REQUEST: 'User request', INTERNAL_ISSUE: 'Internal issue', INCIDENT: 'Incident',
    SOFTWARE: 'Software', HARDWARE: 'Hardware', CONNECTION: 'Connection', ACCESS_PERMISSIONS: 'Access / permissions',
    ACQUISITION_IMAGE_QUALITY: 'Acquisition / image quality', OTHER: 'Other',
    LOW: 'Low', NORMAL: 'Normal', HIGH: 'High', CRITICAL: 'Critical',
  };
  const display = (value) => names[value] || value || 'Not specified';
  const catalogueName = (kind, value) => options?.[kind]?.find((entry) => entry.id === value)?.name || value;
  const staffName = (value) => catalogueName('staff', value) || 'Unassigned';
  const microscopeName = (value) => catalogueName('microscopes', value) || 'Facility-wide';
  const actorName = (value) => value?.startsWith('staff-entered: ')
    ? `staff-entered: ${staffName(value.slice('staff-entered: '.length))}` : value;
  const date = (value) => value ? new Intl.DateTimeFormat(undefined, {
    timeZone: 'Europe/Stockholm', dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value)) : '—';
  let table;
  let options;
  let createRequestId;
  let editTicket;
  let noteTicket;
  let noteDraftTicketId;
  let imageTicket;
  let imageCount = 0;
  const resources = new Map();
  let debounce;

  function node(tag, content, className) {
    const element = document.createElement(tag);
    if (content !== undefined && content !== null) element.textContent = content;
    if (className) element.className = className;
    return element;
  }
  function message(id, value) { $(id).textContent = value || ''; $(id).hidden = !value; }
  function selected(id) { return [...$(id).selectedOptions].map((option) => option.value); }
  function populate(id, values, { optional = false, defaults = [], emptyLabel = 'Not specified' } = {}) {
    const select = typeof id === 'string' ? $(id) : id;
    select.replaceChildren();
    if (optional) select.add(new Option(emptyLabel, ''));
    values.forEach((entry) => {
      const value = typeof entry === 'object' ? entry.id : entry;
      const label = typeof entry === 'object' ? entry.name : display(entry);
      select.add(new Option(label, value, defaults.includes(value), defaults.includes(value)));
    });
  }
  async function loadOptions(force = false) {
    if (options && !force) return;
    const next = await fetchJson('/api/tickets/filter-options');
    if (!options) {
      populate('ticketStatusFilter', next.statuses, { defaults: ['OPEN', 'IN_PROGRESS', 'WAITING'] });
      populate('ticketIssueFilter', next.issueTypes);
      populate('ticketTypeFilter', next.types);
      populate('ticketPriorityFilter', next.priorities);
      populate('ticketCreateType', next.types, { defaults: ['INTERNAL_ISSUE'] });
      populate('ticketCreatePriority', next.priorities, { defaults: ['NORMAL'] });
      populate('ticketCreateIssue', next.issueTypes, { optional: true });
      populate('ticketEditPriority', next.priorities);
      populate('ticketEditIssue', next.issueTypes, { optional: true });
    }
    const previous = selected('ticketMicroscopeFilter');
    populate('ticketMicroscopeFilter', next.microscopes, { defaults: previous });
    for (const [id, entries, emptyLabel] of [
      ['ticketCreateMicroscope', next.microscopes, 'Facility-wide'],
      ['ticketCreateAssigned', next.staff, 'Unassigned'],
      ['ticketEditAssigned', next.staff, 'Unassigned'],
      ['ticketAssignedFilter', next.staff, 'All staff'],
    ]) populate(id, entries, { optional: true, emptyLabel, defaults: [$(id).value] });
    document.querySelectorAll('select.ticket-actor').forEach((select) => {
      populate(select, next.staff, { optional: true, emptyLabel: 'Choose your name',
        defaults: [select.value || sessionStorage.getItem('ticketActor')] });
    });
    options = next;
  }
  function params() {
    const query = new URLSearchParams();
    const fields = {
      search: 'ticketSearch', reporter: 'ticketReporter', message: 'ticketMessageSearch',
      dateField: 'ticketDateField', startDate: 'ticketStartDate', endDate: 'ticketEndDate',
      source: 'ticketSourceFilter', chatState: 'ticketChatFilter', assignedTo: 'ticketAssignedFilter',
      sort: 'ticketSort', order: 'ticketOrder',
    };
    for (const [key, id] of Object.entries(fields)) if ($(id).value.trim()) query.set(key, $(id).value.trim());
    const groups = { status: 'ticketStatusFilter', microscope: 'ticketMicroscopeFilter',
      type: 'ticketTypeFilter', priority: 'ticketPriorityFilter', issueType: 'ticketIssueFilter' };
    for (const [key, id] of Object.entries(groups)) {
      const values = selected(id);
      if (key === 'status' && !values.length) query.set(key, 'all');
      else values.forEach((value) => query.append(key, value));
    }
    for (const [key, id] of Object.entries({ facilityWide: 'ticketFacilityWide',
      issueTypeUnspecified: 'ticketUnspecifiedIssue', unassigned: 'ticketUnassigned' })) {
      if ($(id).checked) query.set(key, 'true');
    }
    const extra = selected('ticketIssueFilter').length + selected('ticketTypeFilter').length
      + selected('ticketPriorityFilter').length + Number($('ticketUnspecifiedIssue').checked)
      + Number($('ticketSourceFilter').value !== 'all') + Number($('ticketChatFilter').value !== 'all')
      + Number(Boolean($('ticketAssignedFilter').value)) + Number($('ticketUnassigned').checked);
    $('ticketMoreFilterCount').textContent = extra ? `(${extra} selected)` : '';
    const status = selected('ticketStatusFilter').map(display).join(', ') || 'All statuses';
    const scopes = selected('ticketMicroscopeFilter').map(microscopeName).join(', ');
    $('ticketFilterSummary').textContent = `${status} · ${scopes || 'All microscopes'}${$('ticketFacilityWide').checked ? ' + facility-wide' : ''} · ${query.get('dateField').replace('_at', '')} dates · Europe/Stockholm`;
    return query;
  }
  function dispose(row) {
    const entry = resources.get(row);
    if (entry) {
      entry.abort.abort();
      entry.urls.forEach((url) => URL.revokeObjectURL(url));
      resources.delete(row);
    }
  }
  function leave() {
    [...resources.keys()].forEach(dispose);
    if (table) table.rows().every(function close() { this.child.hide(); });
    document.querySelectorAll('.ticket-expand').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  }
  function reload(keepPage = false) { leave(); if (table) table.ajax.reload(null, !keepPage); }
  async function loadSummary() {
    try {
      const summary = await fetchJson('/api/tickets/summary');
      for (const [key, label] of [['total', 'Total'], ['active', 'Active'], ['resolved', 'Resolved']]) {
        const metric = summary[key];
        let change = metric.change === null ? 'History incomplete' : `${metric.change > 0 ? '+' : ''}${metric.change.toLocaleString()} vs ${key === 'resolved' ? 'previous 30 days' : '30 days ago'}`;
        if (metric.change_percent !== null) change += ` (${metric.change_percent > 0 ? '+' : ''}${metric.change_percent}%)`;
        for (const prefix of ['overviewTickets', 'tickets']) {
          $(`${prefix}${label}`).textContent = metric.value.toLocaleString();
          $(`${prefix}${label}Change`).textContent = change;
        }
      }
      message('overviewTicketsError', ''); message('ticketSummaryError', '');
    } catch (error) {
      for (const label of ['Total', 'Active', 'Resolved']) for (const prefix of ['overviewTickets', 'tickets']) {
        $(`${prefix}${label}`).textContent = '—'; $(`${prefix}${label}Change`).textContent = 'Unavailable';
      }
      message('overviewTicketsError', error.message); message('ticketSummaryError', error.message);
    }
  }
  function initializeTable() {
    if (table) { reload(true); return; }
    table = new DataTable('#ticketTable', {
      processing: true, serverSide: true, searching: false, ordering: false,
      pageLength: 50, lengthMenu: [25, 50, 100], scrollX: true,
      language: { emptyTable: 'No tickets match these filters. Try Reset filters or add a ticket.',
        zeroRecords: 'No tickets match these filters. Try Reset filters.' },
      ajax(data, callback) {
        const query = params();
        query.set('page', String(Math.floor(data.start / data.length) + 1));
        query.set('pageSize', String(data.length));
        message('ticketTableError', '');
        fetchJson(`/api/tickets?${query}`).then((result) => callback({ draw: data.draw,
          recordsTotal: result.total, recordsFiltered: result.filteredTotal, data: result.data }))
          .catch((error) => {
            message('ticketTableError', error.message);
            callback({ draw: data.draw, recordsTotal: 0, recordsFiltered: 0, data: [] });
          });
      },
      columns: [
        { data: null, defaultContent: '<button class="button is-small ticket-expand" type="button" aria-expanded="false" aria-label="Show ticket details">Details</button>' },
        { data: 'ticket_id', render: DataTable.render.text() },
        { data: 'opened_at', render: date },
        { data: 'reporter_name', render: DataTable.render.text() },
        { data: 'microscope', render: (value) => DataTable.render.text().display(microscopeName(value)) },
        { data: 'message_preview', className: 'ticket-message-preview', render: DataTable.render.text() },
        { data: null, render: (_, type, row) => DataTable.render.text().display(`${display(row.ticket_type)} · ${display(row.priority)}`) },
        { data: 'issue_type', render: (value) => DataTable.render.text().display(display(value)) },
        { data: 'status', render: (value) => `<span class="ticket-status ticket-status-${value.toLowerCase()}">${display(value)}</span>` },
        { data: 'assigned_to', render: (value) => DataTable.render.text().display(staffName(value)) },
        { data: 'resolved_at', render: date },
        { data: 'image_count', render: DataTable.render.number(null, null, 0) },
        { data: null, defaultContent: '<div class="ticket-actions"><button class="button is-small ticket-edit" type="button">Edit ticket</button><button class="button is-small ticket-note" type="button">Add update</button><button class="button is-small ticket-upload" type="button">Add images</button></div>' },
      ],
    });
    table.on('preDraw', leave);
    document.querySelector('#ticketTable tbody').addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const tr = button.closest('tr');
      const row = table.row(tr);
      if (!row.data()) return;
      try {
        if (button.classList.contains('ticket-edit')) await openEdit(row.data().ticket_id);
        if (button.classList.contains('ticket-note')) await openNote(row.data().ticket_id);
        if (button.classList.contains('ticket-upload')) await openImages(row.data().ticket_id);
        if (button.classList.contains('ticket-expand')) {
          if (row.child.isShown()) { row.child.hide(); dispose(tr); button.setAttribute('aria-expanded', 'false'); return; }
          button.setAttribute('aria-expanded', 'true');
          await expand(row, tr);
        }
      } catch (error) { message('ticketTableError', error.message); }
    });
  }
  function field(parent, label, content) {
    const section = node('div', null, 'ticket-detail-field');
    section.append(node('h4', label), node('p', content)); parent.append(section);
  }
  function historyEntry(item) {
    const block = node('article', null, 'ticket-event');
    const changes = item.changes || {};
    block.append(node('strong', `${date(item.occurred_at)} · ${actorName(item.actor)}`));
    block.append(node('p', item.event_type === 'CREATED' ? 'Ticket created'
      : changes.update_kind === 'PROGRESS_NOTE' ? 'Progress update'
      : item.old_status !== item.new_status ? `${display(item.old_status)} → ${display(item.new_status)}` : 'Ticket updated'));
    if (item.note) block.append(node('p', item.note, 'ticket-preserve-text'));
    for (const [key, label] of [['priority', 'Priority'], ['assigned_to', 'Assigned staff'], ['issue_type', 'Issue type']]) {
      if (changes[key]) {
        const format = key === 'assigned_to' ? staffName : display;
        block.append(node('p', `${label}: ${format(changes[key].before)} → ${format(changes[key].after)}`));
      }
    }
    if (changes.resolution_note?.before && !changes.resolution_note.after) block.append(node('p', `Previous closing note: ${changes.resolution_note.before}`, 'ticket-preserve-text'));
    const images = changes.images_added || changes.images;
    if (images?.length) block.append(node('p', `Images added: ${images.map((image) => image.filename).join(', ')}`));
    return block;
  }
  async function previewImage(ticketId, image, tile, resource) {
    const response = await fetch(`/api/tickets/${ticketId}/images/${image.image_id}`, {
      headers: { Authorization: `Bearer ${apiToken}` }, signal: resource.abort.signal,
    });
    if (response.status === 401) {
      apiToken = ''; sessionStorage.removeItem('dashboardToken'); setAuthenticatedState(false);
      throw new Error('Your session expired. Unlock the dashboard to view images.');
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Unable to load image');
    }
    const blob = await response.blob();
    if (resource.abort.signal.aborted || !tile.isConnected) return;
    const url = URL.createObjectURL(blob); resource.urls.push(url);
    const picture = node('img'); picture.src = url; picture.alt = image.filename;
    const download = node('a', 'Download image', 'button is-small');
    download.href = url; download.download = image.filename;
    tile.append(picture, download);
  }
  async function expand(row, tr) {
    dispose(tr);
    const root = node('section', 'Loading ticket…', 'ticket-details');
    row.child(root).show();
    const resource = { abort: new AbortController(), urls: [] }; resources.set(tr, resource);
    const ticketId = row.data().ticket_id;
    try {
      const [ticket, images, events] = await Promise.all([
        fetchJson(`/api/tickets/${ticketId}`), fetchJson(`/api/tickets/${ticketId}/images`),
        fetchJson(`/api/tickets/${ticketId}/events`),
      ]);
      if (!root.isConnected || resource.abort.signal.aborted) return;
      root.replaceChildren(node('h3', `Ticket #${ticketId}`, 'title is-5'));
      const details = node('div', null, 'ticket-detail-grid'); root.append(details);
      field(details, 'Original report', ticket.message);
      field(details, 'Reported by', `${ticket.reporter_name}${ticket.reporter_identifier ? ` · ${ticket.reporter_identifier}` : ''}`);
      field(details, 'Microscope / assigned staff', `${microscopeName(ticket.microscope)} / ${staffName(ticket.assigned_to)}`);
      field(details, 'Opened / updated (Europe/Stockholm)', `${date(ticket.opened_at)} / ${date(ticket.updated_at)}`);
      field(details, 'Closing date', ticket.status === 'CANCELLED' ? date(ticket.closed_at) : date(ticket.resolved_at));
      field(details, 'Resolution / closing note', ticket.resolution_note || 'No closing note provided');
      field(details, 'Source / chat', `${ticket.source === 'DASHBOARD' ? 'Dashboard' : 'Contact form'} · ${ticket.chat_state.replaceAll('_', ' ').toLowerCase()}`);
      if (ticket.chat_thread_id) field(details, 'Chat reference', ticket.chat_thread_id);
      if (ticket.chat_url) {
        const link = node('a', 'Open staff chat', 'button is-small');
        link.href = ticket.chat_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; root.append(link);
      }
      root.append(node('h4', `Images (${images.data.length} / 5)`, 'title is-6'));
      if (!images.data.length) root.append(node('p', 'No images attached.'));
      const gallery = node('div', null, 'ticket-gallery'); root.append(gallery);
      for (const image of images.data) {
        const tile = node('div', null, 'ticket-image');
        tile.append(node('strong', image.filename), node('small', formatBytes(Number(image.size_bytes))));
        const load = node('button', 'Preview image', 'button is-small'); load.type = 'button'; tile.append(load); gallery.append(tile);
        load.addEventListener('click', async () => {
          load.disabled = true;
          try { await previewImage(ticketId, image, tile, resource); load.remove(); }
          catch (error) { if (error.name !== 'AbortError') { load.textContent = error.message; load.disabled = false; } }
        });
      }
      root.append(node('h4', 'History', 'title is-6'));
      const addNote = node('button', 'Add update', 'button is-small'); addNote.type = 'button'; root.append(addNote);
      addNote.addEventListener('click', () => openNote(ticketId).catch((error) => message('ticketTableError', error.message)));
      const history = node('div'); root.append(history);
      if (!events.data.length) history.append(node('p', 'No history has been recorded.'));
      events.data.forEach((item) => history.append(historyEntry(item)));
      if (events.total > events.data.length) {
        const more = node('button', 'Load more history', 'button is-small'); more.type = 'button'; root.append(more);
        let page = 1;
        more.addEventListener('click', async () => {
          more.disabled = true;
          try {
            const next = await fetchJson(`/api/tickets/${ticketId}/events?page=${page + 1}`);
            next.data.forEach((item) => history.append(historyEntry(item))); page += 1;
            if (page * next.pageSize >= next.total) more.remove();
          } catch (error) { more.textContent = error.message; }
          finally { more.disabled = false; }
        });
      }
    } catch (error) { if (root.isConnected) root.replaceChildren(node('p', error.message, 'has-text-danger')); }
  }
  function rememberedActor(form) { form.elements.actor_name.value = sessionStorage.getItem('ticketActor') || ''; }
  function rememberActor(form) { sessionStorage.setItem('ticketActor', form.elements.actor_name.value.trim()); }
  function checkFiles(form, remaining = 5) {
    const files = [...form.elements.images.files];
    if (files.length > remaining) throw new Error(`Choose at most ${remaining} more images for this ticket.`);
    if (files.some((file) => file.size === 0 || file.size > 5242880)) throw new Error('Each image must be non-empty and at most 5 MiB.');
  }
  async function afterWrite(notice) {
    message('ticketNotice', notice);
    reload(true);
    const refreshed = await Promise.allSettled([loadSummary(), loadOptions(true)]);
    const failed = refreshed.find((result) => result.status === 'rejected');
    if (failed) message('ticketTableError', `Ticket saved, but filter options could not refresh: ${failed.reason.message}`);
  }
  async function load() {
    try { await loadOptions(); initializeTable(); await loadSummary(); }
    catch (error) { message('ticketTableError', error.message); }
  }
  async function openEdit(ticketId) {
    const ticket = await fetchJson(`/api/tickets/${ticketId}`);
    editTicket = ticket;
    const form = $('ticketEditForm'); form.reset(); rememberedActor(form);
    populate('ticketEditStatus', options.statuses);
    for (const option of $('ticketEditStatus').options) {
      option.disabled = ['RESOLVED', 'CANCELLED'].includes(ticket.status)
        && ![ticket.status, 'OPEN', 'IN_PROGRESS'].includes(option.value);
    }
    for (const key of ['status', 'priority', 'assigned_to', 'issue_type']) form.elements[key].value = ticket[key] || '';
    $('ticketEditTitle').textContent = `Update ticket #${ticketId}`;
    $('ticketEditContext').textContent = `${ticket.reporter_name} · ${microscopeName(ticket.microscope)} · Version ${ticket.version}`;
    message('ticketEditError', ''); updateEditFields();
    if (!$('ticketEditDialog').open) $('ticketEditDialog').showModal();
  }
  function updateEditFields() {
    if (!editTicket) return;
    const status = $('ticketEditStatus').value;
    const changed = status !== editTicket.status;
    const closing = changed && ['RESOLVED', 'CANCELLED'].includes(status);
    const reopening = changed && ['RESOLVED', 'CANCELLED'].includes(editTicket.status);
    $('ticketClosingField').hidden = !closing;
    $('ticketReopenField').hidden = !reopening;
    $('ticketEditForm').elements.change_note.required = reopening;
  }
  async function openNote(ticketId) {
    const ticket = await fetchJson(`/api/tickets/${ticketId}`);
    const form = $('ticketNoteForm');
    if (noteDraftTicketId && noteDraftTicketId !== ticketId && form.elements.note.value.trim()) {
      message('ticketTableError', `You have an unsaved update for ticket #${noteDraftTicketId}. Open its Add update form to finish or clear that draft first.`);
      return;
    }
    if (noteDraftTicketId !== ticketId) { form.reset(); rememberedActor(form); }
    noteDraftTicketId = ticketId;
    noteTicket = ticket;
    $('ticketNoteTitle').textContent = `Add update to ticket #${ticketId}`;
    $('ticketNoteContext').textContent = `${ticket.reporter_name} · ${microscopeName(ticket.microscope)} · ${display(ticket.status)} · Version ${ticket.version}`;
    $('ticketNoteCount').textContent = `${form.elements.note.value.length.toLocaleString()} / 2,000`;
    message('ticketNoteError', '');
    if (!$('ticketNoteDialog').open) $('ticketNoteDialog').showModal();
  }
  async function openImages(ticketId, preserveFiles = false) {
    const [ticket, images] = await Promise.all([fetchJson(`/api/tickets/${ticketId}`), fetchJson(`/api/tickets/${ticketId}/images`)]);
    imageTicket = ticket; imageCount = images.data.length;
    const form = $('ticketImagesForm');
    if (!preserveFiles) form.reset();
    rememberedActor(form);
    $('ticketImagesContext').textContent = `Ticket #${ticketId} · ${imageCount} / 5 images stored · Version ${ticket.version}`;
    form.querySelector('[type=submit]').disabled = imageCount >= 5;
    message('ticketImagesError', imageCount >= 5 ? 'This ticket already has five images.' : '');
    if (!$('ticketImagesDialog').open) $('ticketImagesDialog').showModal();
  }
  async function submit(form, errorId, action) {
    const button = form.querySelector('[type=submit]');
    button.disabled = true; button.classList.add('is-loading'); message(errorId, '');
    try { rememberActor(form); await action(); }
    catch (error) { message(errorId, error.message); }
    finally { button.disabled = false; button.classList.remove('is-loading'); }
  }

  $('addTicket').addEventListener('click', async () => {
    try {
      await loadOptions();
      if (!createRequestId) { $('ticketCreateForm').reset(); rememberedActor($('ticketCreateForm')); createRequestId = crypto.randomUUID(); }
      message('ticketCreateError', ''); $('ticketCreateDialog').showModal();
    } catch (error) { message('ticketTableError', error.message); }
  });
  document.querySelectorAll('[data-close-ticket-dialog]').forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog').close());
  });
  $('ticketCreateForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    submit(form, 'ticketCreateError', async () => {
      checkFiles(form);
      const body = new FormData(form); body.set('source_event_id', createRequestId);
      if (!form.elements.images.files.length) body.delete('images');
      const ticket = await fetchJson('/api/tickets', { method: 'POST', body });
      createRequestId = null; $('ticketCreateDialog').close();
      await afterWrite(`Ticket #${ticket.ticket_id} created. Its visibility depends on the current filters.`);
    });
  });
  $('ticketEditStatus').addEventListener('change', updateEditFields);
  $('ticketEditForm').elements.resolution_note.addEventListener('input', (event) => {
    $('ticketClosingCount').textContent = `${event.target.value.length} / 2,000`;
  });
  $('reloadTicketEdit').addEventListener('click', () => openEdit(editTicket.ticket_id).catch((error) => message('ticketEditError', error.message)));
  $('ticketEditForm').addEventListener('submit', (event) => {
    event.preventDefault(); const form = event.currentTarget;
    submit(form, 'ticketEditError', async () => {
      const body = { version: editTicket.version };
      for (const key of ['status', 'priority', 'issue_type', 'assigned_to', 'actor_name']) body[key] = form.elements[key].value;
      if (!$('ticketClosingField').hidden) body.resolution_note = form.elements.resolution_note.value;
      if (!$('ticketReopenField').hidden) body.change_note = form.elements.change_note.value;
      await fetchJson(`/api/tickets/${editTicket.ticket_id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      $('ticketEditDialog').close();
      await afterWrite(`Ticket #${editTicket.ticket_id} updated. A resolved or cancelled ticket may be hidden by the current status filters.`);
    });
  });
  $('ticketNoteForm').elements.note.addEventListener('input', (event) => {
    $('ticketNoteCount').textContent = `${event.target.value.length.toLocaleString()} / 2,000`;
  });
  $('reloadTicketNote').addEventListener('click', () => openNote(noteTicket.ticket_id).catch((error) => message('ticketNoteError', error.message)));
  $('ticketNoteForm').addEventListener('submit', (event) => {
    event.preventDefault(); const form = event.currentTarget;
    submit(form, 'ticketNoteError', async () => {
      if (!form.elements.note.value.trim()) throw new Error('Enter a progress update before saving.');
      const body = { version: noteTicket.version, note: form.elements.note.value, actor_name: form.elements.actor_name.value };
      await fetchJson(`/api/tickets/${noteTicket.ticket_id}/notes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const ticketId = noteTicket.ticket_id;
      noteDraftTicketId = null; form.reset(); $('ticketNoteDialog').close();
      await afterWrite(`Update added to ticket #${ticketId}. Expand its details to read the history.`);
    });
  });
  $('reloadTicketImages').addEventListener('click', () => openImages(imageTicket.ticket_id, true).catch((error) => message('ticketImagesError', error.message)));
  $('ticketImagesForm').addEventListener('submit', (event) => {
    event.preventDefault(); const form = event.currentTarget;
    submit(form, 'ticketImagesError', async () => {
      checkFiles(form, 5 - imageCount);
      const body = new FormData(form); body.set('version', String(imageTicket.version));
      await fetchJson(`/api/tickets/${imageTicket.ticket_id}/images`, { method: 'POST', body });
      $('ticketImagesDialog').close(); await afterWrite(`Images added to ticket #${imageTicket.ticket_id}. Expand its details to preview them.`);
    });
  });
  $('ticketFilters').addEventListener('submit', (event) => event.preventDefault());
  $('ticketFilters').addEventListener('input', (event) => {
    if (!['search', 'text'].includes(event.target.type)) return;
    clearTimeout(debounce); debounce = setTimeout(() => reload(), 350);
  });
  $('ticketFilters').addEventListener('change', (event) => {
    if (event.target.type === 'search' || event.target.type === 'text') return;
    if (event.target.id === 'ticketUnassigned') $('ticketAssignedFilter').disabled = event.target.checked;
    if (['ticketStartDate', 'ticketEndDate'].includes(event.target.id)) $('ticketDatePreset').value = 'custom';
    if (event.target.id === 'ticketDatePreset') {
      const preset = event.target.value;
      if (preset === 'all') { $('ticketStartDate').value = ''; $('ticketEndDate').value = ''; }
      else if (preset !== 'custom') {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(new Date()).map((part) => [part.type, part.value]));
        const today = `${parts.year}-${parts.month}-${parts.day}`;
        const start = new Date(`${today}T12:00:00Z`);
        start.setUTCDate(start.getUTCDate() - (preset === 'today' ? 0 : Number(preset) - 1));
        $('ticketStartDate').value = start.toISOString().slice(0, 10); $('ticketEndDate').value = today;
      }
    }
    reload();
  });
  $('resetTicketFilters').addEventListener('click', () => { $('ticketFilters').reset(); $('ticketAssignedFilter').disabled = false; reload(); });
  $('refreshTickets').addEventListener('click', async () => {
    try { await loadOptions(true); if (!table) initializeTable(); else reload(true); await loadSummary(); }
    catch (error) { message('ticketTableError', error.message); }
  });
  return { load, loadSummary, leave };
})();
