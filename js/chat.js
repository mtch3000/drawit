// ================================================================
//  DRAW TOGETHER — chat.js
//  Group Chat System with Firebase Realtime Database
//  - Max 10 groups at a time
//  - Max 10 members per group
//  - Max 100 messages per group (ring buffer)
//  - Max 500 chars per message
//  - User picks a name, gets a unique color
//  - Owner-only link sharing
// ================================================================

(function () {
  'use strict';

  // ── CONSTANTS ──────────────────────────────────────────────────
  const MAX_GROUPS    = 10;
  const MAX_MEMBERS   = 10;
  const MAX_MESSAGES  = 100;
  const MAX_MSG_CHARS = 500;

  // Palette of 20 vivid game-style member colors
  const MEMBER_COLORS = [
    '#FF6B6B','#FFD93D','#6BCB77','#4D96FF','#FF922B',
    '#CC5DE8','#20C997','#F06595','#74C0FC','#A9E34B',
    '#FF8787','#63E6BE','#FFA94D','#DA77F2','#38D9A9',
    '#F783AC','#5C7CFA','#FCC419','#66D9E8','#94D82D'
  ];

  // ── STATE ──────────────────────────────────────────────────────
  let chatDb          = null;   // Firebase db reference
  let currentGroupId  = null;   // Which group we're in
  let currentGroupRef = null;   // Firebase ref for current group
  let myMemberId      = null;   // Our key inside group/members
  let myColor         = null;
  let myName          = null;
  let isOwner         = false;
  let msgListenerOff  = null;   // Unsubscribe function for messages listener
  let memberListenerOff = null;
  let presenceRef     = null;
  let allGroupsCache  = {};     // groupId → group snapshot

  // ── INIT (called from app.js after Firebase is ready) ──────────
  function init() {
    chatDb = firebase.database();
    _buildUI();
    _bindChatBtnClick();
    _checkInviteLink();
  }

  // ── CHECK FOR ?chat=GROUP_ID IN URL ──────────────────────────
  function _checkInviteLink() {
    const params  = new URLSearchParams(window.location.search);
    const groupId = params.get('chat');
    if (!groupId) return;

    // Clean URL without reload
    const clean = window.location.pathname;
    window.history.replaceState({}, '', clean);

    // Open lobby pointing at this group's join flow
    _openLobby(groupId);
  }

  // ── BUILD ALL UI ──────────────────────────────────────────────
  function _buildUI() {
    // Chat FAB on toolbar
    const fab = document.createElement('button');
    fab.id        = 'chat-fab';
    fab.title     = 'Group Chat';
    fab.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           width="18" height="18">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
      </svg>
      <span id="chat-unread" class="chat-unread-badge hidden">0</span>
    `;
    document.getElementById('toolbar').appendChild(fab);

    // Overlay container (lobby + chatroom)
    const overlay = document.createElement('div');
    overlay.id = 'chat-overlay';
    overlay.innerHTML = `
      <!-- LOBBY PANEL -->
      <div id="chat-lobby" class="chat-panel">
        <div class="chat-panel-header">
          <span class="chat-panel-title">⚡ Game Chat</span>
          <button class="chat-close-btn" id="chat-close-lobby">✕</button>
        </div>

        <!-- Name entry (shown first time) -->
        <div id="chat-name-step" class="chat-step">
          <p class="chat-step-label">Pick your player name</p>
          <div class="chat-input-row">
            <input id="chat-name-input" type="text" maxlength="20"
                   placeholder="Enter name…" autocomplete="off" spellcheck="false"/>
            <button id="chat-name-confirm" class="chat-btn-primary">Go</button>
          </div>
          <p class="chat-hint">Max 20 characters. This shows to everyone in your group.</p>
        </div>

        <!-- Main lobby (shown after name is set) -->
        <div id="chat-lobby-main" class="chat-step hidden">
          <div class="chat-player-badge" id="chat-player-badge">
            <span class="chat-player-dot" id="chat-player-dot"></span>
            <span id="chat-player-name-display"></span>
            <button id="chat-change-name-btn" class="chat-btn-ghost" title="Change name">✎</button>
          </div>

          <div class="chat-lobby-actions">
            <button id="chat-create-btn" class="chat-btn-primary">+ Create Group</button>
          </div>

          <!-- Group list -->
          <div class="chat-section-label">Live Groups</div>
          <div id="chat-groups-list" class="chat-groups-list">
            <p class="chat-empty-state">No groups yet. Create one!</p>
          </div>
        </div>
      </div>

      <!-- CREATE GROUP PANEL -->
      <div id="chat-create-panel" class="chat-panel hidden">
        <div class="chat-panel-header">
          <button class="chat-back-btn" id="chat-create-back">← Back</button>
          <span class="chat-panel-title">New Group</span>
          <div style="width:40px"></div>
        </div>
        <div class="chat-step">
          <p class="chat-step-label">Group name</p>
          <input id="chat-group-name-input" type="text" maxlength="30"
                 placeholder="e.g. Squad Alpha…" autocomplete="off" spellcheck="false" class="chat-full-input"/>
          <p class="chat-step-label" style="margin-top:16px">Max members</p>
          <div class="chat-max-row">
            <input id="chat-max-members" type="range" min="2" max="10" value="10"/>
            <span id="chat-max-members-val">10</span>
          </div>
          <button id="chat-create-confirm" class="chat-btn-primary" style="margin-top:20px;width:100%">
            Create Group
          </button>
          <p id="chat-create-error" class="chat-error hidden"></p>
        </div>
      </div>

      <!-- CHATROOM PANEL -->
      <div id="chat-room-panel" class="chat-panel hidden">
        <div class="chat-panel-header">
          <button class="chat-back-btn" id="chat-room-back">← Leave</button>
          <div class="chat-room-info">
            <span id="chat-room-name" class="chat-panel-title"></span>
            <span id="chat-room-count" class="chat-member-count"></span>
          </div>
          <button id="chat-share-btn" class="chat-btn-share hidden" title="Share invite link">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
                 width="15" height="15">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/>
              <circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
          </button>
        </div>

        <!-- Member strip -->
        <div id="chat-members-strip" class="chat-members-strip"></div>

        <!-- Messages area -->
        <div id="chat-messages" class="chat-messages"></div>

        <!-- Input -->
        <div class="chat-input-area">
          <input id="chat-msg-input" type="text" maxlength="500"
                 placeholder="Message… (500 chars max)" autocomplete="off" spellcheck="false"/>
          <button id="chat-send-btn" class="chat-btn-send">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </div>
        <div class="chat-char-counter">
          <span id="chat-char-count">0</span>/500
        </div>
      </div>

      <!-- TOAST -->
      <div id="chat-toast" class="chat-toast hidden"></div>
    `;
    document.body.appendChild(overlay);

    _bindLobbyEvents();
    _bindCreateEvents();
    _bindRoomEvents();
  }

  // ── BIND: FAB button ──────────────────────────────────────────
  function _bindChatBtnClick() {
    document.getElementById('chat-fab').addEventListener('click', () => {
      if (currentGroupId) {
        _showPanel('room');
      } else {
        _openLobby();
      }
      _clearUnread();
    });
  }

  // ── BIND: Lobby events ────────────────────────────────────────
  function _bindLobbyEvents() {
    document.getElementById('chat-close-lobby').addEventListener('click', _closeOverlay);

    // Name step
    const nameInput   = document.getElementById('chat-name-input');
    const nameConfirm = document.getElementById('chat-name-confirm');

    const confirmName = () => {
      const val = nameInput.value.trim();
      if (!val) { nameInput.focus(); return; }
      _setMyName(val);
    };
    nameConfirm.addEventListener('click', confirmName);
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmName(); });

    // Change name
    document.getElementById('chat-change-name-btn').addEventListener('click', () => {
      localStorage.removeItem('dt_chat_name');
      myName = null;
      _showNameStep();
    });

    // Create group
    document.getElementById('chat-create-btn').addEventListener('click', () => _showPanel('create'));
  }

  // ── BIND: Create panel events ─────────────────────────────────
  function _bindCreateEvents() {
    document.getElementById('chat-create-back').addEventListener('click', () => _showPanel('lobby'));

    const slider  = document.getElementById('chat-max-members');
    const valSpan = document.getElementById('chat-max-members-val');
    slider.addEventListener('input', () => { valSpan.textContent = slider.value; });

    document.getElementById('chat-create-confirm').addEventListener('click', _handleCreateGroup);
    document.getElementById('chat-group-name-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') _handleCreateGroup();
    });
  }

  // ── BIND: Room events ─────────────────────────────────────────
  function _bindRoomEvents() {
    document.getElementById('chat-room-back').addEventListener('click', _leaveGroup);
    document.getElementById('chat-share-btn').addEventListener('click', _shareLink);

    const msgInput = document.getElementById('chat-msg-input');
    const charCount = document.getElementById('chat-char-count');

    msgInput.addEventListener('input', () => {
      charCount.textContent = msgInput.value.length;
    });
    msgInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendMessage(); }
    });
    document.getElementById('chat-send-btn').addEventListener('click', _sendMessage);
  }

  // ── OPEN LOBBY ────────────────────────────────────────────────
  function _openLobby(pendingJoinId) {
    const overlay = document.getElementById('chat-overlay');
    overlay.classList.add('visible');

    // Store pending join if coming from invite link
    if (pendingJoinId) overlay.dataset.pendingJoin = pendingJoinId;

    const saved = localStorage.getItem('dt_chat_name');
    if (saved) {
      myName = saved;
      _showLobbyMain();
    } else {
      _showNameStep();
    }
    _showPanel('lobby');
  }

  function _closeOverlay() {
    document.getElementById('chat-overlay').classList.remove('visible');
  }

  function _showPanel(which) {
    document.getElementById('chat-lobby').classList.add('hidden');
    document.getElementById('chat-create-panel').classList.add('hidden');
    document.getElementById('chat-room-panel').classList.add('hidden');
    document.getElementById('chat-overlay').classList.add('visible');

    if (which === 'lobby')  document.getElementById('chat-lobby').classList.remove('hidden');
    if (which === 'create') document.getElementById('chat-create-panel').classList.remove('hidden');
    if (which === 'room')   document.getElementById('chat-room-panel').classList.remove('hidden');
  }

  // ── NAME STEP ─────────────────────────────────────────────────
  function _showNameStep() {
    document.getElementById('chat-name-step').classList.remove('hidden');
    document.getElementById('chat-lobby-main').classList.add('hidden');
    document.getElementById('chat-name-input').value = '';
    setTimeout(() => document.getElementById('chat-name-input').focus(), 50);
  }

  function _setMyName(name) {
    myName = name;
    localStorage.setItem('dt_chat_name', name);
    _showLobbyMain();
  }

  function _showLobbyMain() {
    document.getElementById('chat-name-step').classList.add('hidden');
    document.getElementById('chat-lobby-main').classList.remove('hidden');
    document.getElementById('chat-player-name-display').textContent = myName;

    // Assign/recall persistent color
    let color = localStorage.getItem('dt_chat_color');
    if (!color) {
      color = MEMBER_COLORS[Math.floor(Math.random() * MEMBER_COLORS.length)];
      localStorage.setItem('dt_chat_color', color);
    }
    myColor = color;
    document.getElementById('chat-player-dot').style.background = color;

    _loadGroupsList();

    // Handle pending join from invite link
    const overlay = document.getElementById('chat-overlay');
    if (overlay.dataset.pendingJoin) {
      const gid = overlay.dataset.pendingJoin;
      delete overlay.dataset.pendingJoin;
      setTimeout(() => _joinGroup(gid), 300);
    }
  }

  // ── GROUPS LIST ───────────────────────────────────────────────
  function _loadGroupsList() {
    const listEl = document.getElementById('chat-groups-list');
    chatDb.ref('chat_groups').on('value', snap => {
      allGroupsCache = snap.val() || {};
      const groups = Object.entries(allGroupsCache).filter(([, g]) => g && g.name);

      listEl.innerHTML = '';
      if (!groups.length) {
        listEl.innerHTML = '<p class="chat-empty-state">No groups yet. Create one!</p>';
        return;
      }

      groups.forEach(([id, group]) => {
        const memberCount = Object.keys(group.members || {}).length;
        const isFull      = memberCount >= (group.maxMembers || 10);
        const isMe        = _isMyGroup(id);

        const card = document.createElement('div');
        card.className = 'chat-group-card' + (isFull && !isMe ? ' full' : '');
        card.innerHTML = `
          <div class="cgc-info">
            <span class="cgc-name">${_escHtml(group.name)}</span>
            <span class="cgc-meta">
              ${memberCount}/${group.maxMembers || 10} players
              ${group.ownerId === _getMyPersistentId() ? '<span class="cgc-crown">👑</span>' : ''}
            </span>
          </div>
          <button class="chat-btn-join ${isFull && !isMe ? 'disabled' : ''}"
                  ${isFull && !isMe ? 'disabled' : ''}
                  data-gid="${id}">
            ${isMe ? 'Rejoin' : isFull ? 'Full' : 'Join'}
          </button>
        `;
        listEl.appendChild(card);

        if (!isFull || isMe) {
          card.querySelector('.chat-btn-join').addEventListener('click', () => _joinGroup(id));
        }
      });
    });
  }

  function _isMyGroup(gid) {
    const g = allGroupsCache[gid];
    if (!g || !g.members) return false;
    return Object.values(g.members).some(m => m.persistentId === _getMyPersistentId());
  }

  // ── CREATE GROUP ──────────────────────────────────────────────
  function _handleCreateGroup() {
    const nameInput  = document.getElementById('chat-group-name-input');
    const maxSlider  = document.getElementById('chat-max-members');
    const errorEl    = document.getElementById('chat-create-error');

    const groupName = nameInput.value.trim();
    if (!groupName) {
      _showCreateError('Give your group a name first.'); return;
    }

    // Count existing groups
    chatDb.ref('chat_groups').once('value', snap => {
      const groups = snap.val() || {};
      const active = Object.keys(groups).length;
      if (active >= MAX_GROUPS) {
        _showCreateError(`Maximum ${MAX_GROUPS} groups are active. Try joining one!`);
        return;
      }

      const newRef   = chatDb.ref('chat_groups').push();
      const groupId  = newRef.key;
      const persistId = _getMyPersistentId();

      const memberKey = chatDb.ref('chat_groups/' + groupId + '/members').push().key;
      myMemberId = memberKey;

      const groupData = {
        name:       groupName,
        maxMembers: parseInt(maxSlider.value, 10),
        ownerId:    persistId,
        createdAt:  firebase.database.ServerValue.TIMESTAMP,
        members: {
          [memberKey]: {
            name:        myName,
            color:       myColor,
            persistentId: persistId,
            joinedAt:    firebase.database.ServerValue.TIMESTAMP
          }
        }
      };

      newRef.set(groupData).then(() => {
        isOwner = true;
        nameInput.value = '';
        errorEl.classList.add('hidden');
        _enterRoom(groupId);
      }).catch(err => {
        _showCreateError('Could not create group. Try again.');
        console.error(err);
      });
    });
  }

  function _showCreateError(msg) {
    const el = document.getElementById('chat-create-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  // ── JOIN GROUP ────────────────────────────────────────────────
  function _joinGroup(groupId) {
    const groupRef = chatDb.ref('chat_groups/' + groupId);
    groupRef.once('value', snap => {
      const group = snap.val();
      if (!group) { _showToast('Group no longer exists.'); return; }

      const members    = group.members || {};
      const memberList = Object.values(members);
      const persistId  = _getMyPersistentId();

      // Check if we're already a member
      const existing = Object.entries(members).find(([, m]) => m.persistentId === persistId);
      if (existing) {
        myMemberId = existing[0];
        isOwner    = group.ownerId === persistId;
        _enterRoom(groupId);
        return;
      }

      // Check capacity
      if (memberList.length >= (group.maxMembers || 10)) {
        _showToast('This group is full!'); return;
      }

      // Add ourselves
      const memberKey = groupRef.child('members').push().key;
      myMemberId = memberKey;
      isOwner    = false;

      groupRef.child('members/' + memberKey).set({
        name:        myName,
        color:       myColor,
        persistentId: persistId,
        joinedAt:    firebase.database.ServerValue.TIMESTAMP
      }).then(() => {
        _enterRoom(groupId);
      }).catch(err => {
        _showToast('Could not join group.');
        console.error(err);
      });
    });
  }

  // ── ENTER ROOM ────────────────────────────────────────────────
  function _enterRoom(groupId) {
    currentGroupId  = groupId;
    currentGroupRef = chatDb.ref('chat_groups/' + groupId);

    _showPanel('room');

    // Set name in header
    currentGroupRef.child('name').once('value', s => {
      document.getElementById('chat-room-name').textContent = s.val() || 'Group Chat';
    });

    // Show share button only for owner
    currentGroupRef.child('ownerId').once('value', s => {
      const isOwnr = s.val() === _getMyPersistentId();
      isOwner = isOwnr;
      const shareBtn = document.getElementById('chat-share-btn');
      if (isOwnr) shareBtn.classList.remove('hidden');
      else shareBtn.classList.add('hidden');
    });

    // Listen to members
    memberListenerOff && memberListenerOff();
    memberListenerOff = null;
    const membersRef = currentGroupRef.child('members');
    const onMembers  = membersRef.on('value', snap => {
      _renderMembers(snap.val() || {});
    });
    memberListenerOff = () => membersRef.off('value', onMembers);

    // Listen to messages
    msgListenerOff && msgListenerOff();
    msgListenerOff = null;
    const messagesRef = currentGroupRef.child('messages');
    const onMessages  = messagesRef.limitToLast(MAX_MESSAGES).on('value', snap => {
      _renderMessages(snap.val() || {});
    });
    msgListenerOff = () => messagesRef.off('value', onMessages);

    // Add system message
    _postSystemMsg(myName + ' joined the chat');

    // Focus input
    setTimeout(() => document.getElementById('chat-msg-input').focus(), 100);
  }

  // ── LEAVE GROUP ───────────────────────────────────────────────
  function _leaveGroup() {
    if (!currentGroupId || !myMemberId) {
      _resetRoomState();
      _showPanel('lobby');
      return;
    }

    _postSystemMsg(myName + ' left the chat').then(() => {
      // Remove from members
      currentGroupRef.child('members/' + myMemberId).remove();

      // If owner and now 0 members, delete whole group
      currentGroupRef.child('members').once('value', snap => {
        const remaining = snap.val();
        if (!remaining || Object.keys(remaining).length === 0) {
          currentGroupRef.remove();
        }
      });
    });

    if (msgListenerOff) { msgListenerOff(); msgListenerOff = null; }
    if (memberListenerOff) { memberListenerOff(); memberListenerOff = null; }

    _resetRoomState();
    _showPanel('lobby');
  }

  function _resetRoomState() {
    currentGroupId  = null;
    currentGroupRef = null;
    myMemberId      = null;
    isOwner         = false;
    document.getElementById('chat-messages').innerHTML = '';
    document.getElementById('chat-members-strip').innerHTML = '';
    document.getElementById('chat-msg-input').value = '';
    document.getElementById('chat-char-count').textContent = '0';
  }

  // ── RENDER MEMBERS ────────────────────────────────────────────
  function _renderMembers(members) {
    const strip = document.getElementById('chat-members-strip');
    const list  = Object.values(members);
    strip.innerHTML = '';
    list.forEach(m => {
      const dot = document.createElement('div');
      dot.className = 'chat-member-dot';
      dot.title     = m.name;
      dot.style.background = m.color || '#aaa';
      dot.innerHTML = `<span>${(m.name || '?')[0].toUpperCase()}</span>`;
      strip.appendChild(dot);
    });
    document.getElementById('chat-room-count').textContent = `${list.length} online`;
  }

  // ── SEND MESSAGE ──────────────────────────────────────────────
  function _sendMessage() {
    if (!currentGroupRef || !myMemberId) return;
    const input = document.getElementById('chat-msg-input');
    const text  = input.value.trim();
    if (!text) return;
    if (text.length > MAX_MSG_CHARS) return;

    const messagesRef = currentGroupRef.child('messages');

    // Check count → enforce 100-message ring buffer
    messagesRef.once('value', snap => {
      const msgs = snap.val() || {};
      const keys = Object.keys(msgs);
      if (keys.length >= MAX_MESSAGES) {
        // Remove oldest
        const oldest = keys.sort()[0];
        messagesRef.child(oldest).remove();
      }

      messagesRef.push({
        text:      text,
        name:      myName,
        color:     myColor,
        uid:       _getMyPersistentId(),
        timestamp: firebase.database.ServerValue.TIMESTAMP,
        type:      'user'
      });

      input.value = '';
      document.getElementById('chat-char-count').textContent = '0';
    });
  }

  function _postSystemMsg(text) {
    if (!currentGroupRef) return Promise.resolve();
    return currentGroupRef.child('messages').push({
      text,
      type:      'system',
      timestamp: firebase.database.ServerValue.TIMESTAMP
    });
  }

  // ── RENDER MESSAGES ───────────────────────────────────────────
  function _renderMessages(msgs) {
    const container = document.getElementById('chat-messages');
    const sorted    = Object.values(msgs).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const wasAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 40;

    container.innerHTML = '';
    sorted.forEach(msg => {
      const el = document.createElement('div');

      if (msg.type === 'system') {
        el.className = 'chat-msg-system';
        el.textContent = msg.text;
      } else {
        const isMe = msg.uid === _getMyPersistentId();
        el.className = 'chat-msg ' + (isMe ? 'chat-msg-me' : 'chat-msg-them');

        const time = msg.timestamp ? _fmtTime(msg.timestamp) : '';
        el.innerHTML = `
          <div class="chat-msg-bubble" style="--bubble-color:${msg.color || '#aaa'}">
            ${!isMe ? `<span class="chat-msg-name" style="color:${msg.color}">${_escHtml(msg.name || '?')}</span>` : ''}
            <p class="chat-msg-text">${_escHtml(msg.text)}</p>
            <span class="chat-msg-time">${time}</span>
          </div>
        `;
      }

      container.appendChild(el);
    });

    if (wasAtBottom) {
      container.scrollTop = container.scrollHeight;
    } else if (document.getElementById('chat-room-panel').classList.contains('hidden')) {
      _bumpUnread();
    }
  }

  // ── SHARE LINK ────────────────────────────────────────────────
  function _shareLink() {
    if (!currentGroupId) return;
    const url = `${window.location.origin}${window.location.pathname}?chat=${currentGroupId}`;

    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        _showToast('Invite link copied! Share it with your squad 🎮');
      });
    } else {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      _showToast('Invite link copied!');
    }
  }

  // ── UNREAD BADGE ──────────────────────────────────────────────
  let unreadCount = 0;
  function _bumpUnread() {
    unreadCount++;
    const badge = document.getElementById('chat-unread');
    badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
    badge.classList.remove('hidden');
  }
  function _clearUnread() {
    unreadCount = 0;
    document.getElementById('chat-unread').classList.add('hidden');
  }

  // ── TOAST ─────────────────────────────────────────────────────
  let toastTimer = null;
  function _showToast(msg) {
    const toast = document.getElementById('chat-toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.classList.add('hidden'), 350);
    }, 3000);
  }

  // ── HELPERS ───────────────────────────────────────────────────
  function _getMyPersistentId() {
    // Reuse the app's MY_USER_ID if available, else make our own
    return (typeof MY_USER_ID !== 'undefined') ? MY_USER_ID
      : localStorage.getItem('drawtogether_uid') || 'anon';
  }

  function _escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _fmtTime(ts) {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
  }

  // ── EXPORT ────────────────────────────────────────────────────
  window.DrawChat = { init };

})();
