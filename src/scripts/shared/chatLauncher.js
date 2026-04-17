const { ipcRenderer: chatIpcRenderer } = require('electron');

window.__sharedChatWidgetActive = true;

(function () {
    let sessaoAtual = null;
    let chatState = [];
    let chatUsersState = [];
    let chatUnreadState = 0;
    let chatOnlineUsersSet = new Set();
    let chatPendingAttachment = null;
    let chatPollTimer = null;
    let chatSearchTerm = '';
    let chatModalResolver = null;

    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatDateTime(value) {
        const parsed = Date.parse(String(value || ''));
        if (!Number.isFinite(parsed)) return '-';
        return new Date(parsed).toLocaleString('pt-BR');
    }

    function formatBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    }

    function resumirMensagemChat(item) {
        const text = String(item?.text || '').trim();
        if (text) return text;
        const attachment = item?.attachment;
        if (!attachment) return 'Sem mensagens';
        if (String(attachment.kind || '').toLowerCase() === 'image') return '[Imagem]';
        if (String(attachment.kind || '').toLowerCase() === 'pdf') return '[PDF]';
        return '[Arquivo]';
    }

    function normalizarBusca(text) {
        return String(text || '')
            .trim()
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
    }

    function tocarSomNovaMensagem() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            const oscillator = ctx.createOscillator();
            const gain = ctx.createGain();
            oscillator.type = 'sine';
            oscillator.frequency.value = 880;
            gain.gain.value = 0.05;
            oscillator.connect(gain);
            gain.connect(ctx.destination);
            oscillator.start();
            setTimeout(() => {
                oscillator.stop();
                ctx.close().catch(() => {});
            }, 120);
        } catch (error) {
            console.warn('Falha ao tocar alerta de chat:', error);
        }
    }

    function renderWidget() {
        const style = document.createElement('style');
        style.textContent = `
            .chat-fab{position:fixed;right:18px;bottom:18px;z-index:1200;border:1px solid var(--border-color,#dee2e6);border-radius:24px;padding:10px 14px;background:var(--card-background,#fff);color:var(--text-color,#333);cursor:pointer;display:inline-flex;align-items:center;gap:8px;box-shadow:0 8px 18px rgba(0,0,0,.14)}
            .chat-fab.has-alert{animation:chatPulse 1.1s ease-in-out infinite}
            @keyframes chatPulse{0%{box-shadow:0 0 0 0 rgba(33,150,243,.38)}70%{box-shadow:0 0 0 10px rgba(33,150,243,0)}100%{box-shadow:0 0 0 0 rgba(33,150,243,0)}}
            .chat-unread-badge{min-width:22px;height:22px;border-radius:999px;background:#d93025;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:.75rem;padding:0 6px}
            .chat-panel{position:fixed;right:18px;bottom:70px;width:min(480px,95vw);height:min(620px,76vh);max-height:76vh;z-index:1201;border:1px solid var(--border-color,#dee2e6);border-radius:12px;background:var(--modal-content-background,var(--card-background,#fff));box-shadow:0 12px 28px rgba(0,0,0,.18);display:none;flex-direction:column;overflow:hidden}
            .chat-panel.active{display:flex}
            .chat-panel-header{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px;border-bottom:1px solid var(--border-color,#dee2e6)}
            .chat-header-left,.chat-header-actions{display:flex;align-items:center;gap:6px}
            .chat-back-btn,.chat-menu-trigger,.chat-close-btn,.chat-attach-btn,.chat-detach-btn,.chat-send-btn,.chat-open-file{border:1px solid var(--border-color,#dee2e6);border-radius:8px;background:var(--card-background,#fff);color:var(--text-color,#333);padding:6px 10px;cursor:pointer}
            .chat-back-btn{display:none}
            .chat-panel.in-conversation .chat-back-btn{display:inline-flex}
            .chat-menu{position:relative}
            .chat-menu-list{position:absolute;right:0;top:calc(100% + 4px);z-index:2;min-width:190px;border:1px solid var(--border-color,#dee2e6);border-radius:8px;background:var(--card-background,#fff);display:none;flex-direction:column;overflow:hidden}
            .chat-menu-list.active{display:flex}
            .chat-menu-item{border:0;border-bottom:1px solid var(--border-color,#dee2e6);background:transparent;color:var(--text-color,#333);text-align:left;padding:9px 10px;cursor:pointer}
            .chat-menu-item:last-child{border-bottom:0}
            .chat-menu-item:hover,.chat-contact-item:hover{background:rgba(0,0,0,.04)}
            .chat-contacts,.chat-messages{flex:1;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
            .chat-contacts-search{padding:10px 10px 0}
            .chat-contacts-search input{width:100%;border:1px solid var(--border-color,#dee2e6);border-radius:8px;padding:7px 10px;background:var(--card-background,#fff);color:var(--text-color,#333);font-size:.88rem}
            .chat-conversation{flex:1;min-height:0;display:none;flex-direction:column}
            .chat-panel.in-conversation .chat-conversation{display:flex}
            .chat-panel.in-conversation .chat-contacts-wrap{display:none}
            .chat-contact-item{border:1px solid var(--border-color,#dee2e6);border-radius:8px;padding:10px;display:flex;align-items:flex-start;gap:10px}
            .chat-contact-main{flex:1;min-width:0;border:0;background:transparent;color:inherit;text-align:left;padding:0;cursor:pointer}
            .chat-contact-title{display:flex;align-items:center;gap:6px;font-weight:600}
            .chat-contact-preview{margin-top:4px;font-size:.82rem;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .chat-contact-delete{border:0;background:transparent;color:#b44a4a;cursor:pointer;font-size:1rem;line-height:1;padding:2px 0}
            .chat-message{border:1px solid var(--border-color,#dee2e6);border-radius:8px;padding:8px;max-width:92%;align-self:flex-start;background:rgba(0,0,0,.02)}
            .chat-message.is-me{align-self:flex-end;background:rgba(33,150,243,.08)}
            .chat-message-meta,.chat-message-footer,.users-item-meta,.search-status{color:var(--text-secondary,#666)}
            .chat-message-meta{font-size:.8rem;margin-bottom:6px}
            .chat-message-text{white-space:pre-wrap;word-break:break-word}
            .chat-attachment{margin-top:6px;border:1px dashed var(--border-color,#dee2e6);border-radius:6px;padding:6px 8px;font-size:.85rem}
            .chat-message-footer{display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:.78rem}
            .chat-message-delete{border:0;background:transparent;color:#b44a4a;cursor:pointer;font-size:.78rem;padding:0}
            .chat-receipt{font-weight:700}
            .chat-receipt.is-received{color:#1976d2}
            .chat-receipt.is-read{color:#1b8f3a}
            .chat-modal-overlay{position:fixed;inset:0;z-index:1300;background:rgba(0,0,0,.35);display:none;align-items:center;justify-content:center;padding:16px}
            .chat-modal-overlay.active{display:flex}
            .chat-modal{width:min(360px,100%);background:var(--card-background,#fff);color:var(--text-color,#333);border:1px solid var(--border-color,#dee2e6);border-radius:12px;box-shadow:0 12px 28px rgba(0,0,0,.18);padding:16px}
            .chat-modal h3{margin:0 0 8px;font-size:1rem}
            .chat-modal p{margin:0 0 14px;color:var(--text-secondary,#666)}
            .chat-modal-actions{display:flex;justify-content:flex-end;gap:8px}
            .chat-modal-btn{border:1px solid var(--border-color,#dee2e6);border-radius:8px;background:var(--card-background,#fff);color:var(--text-color,#333);padding:8px 12px;cursor:pointer}
            .chat-modal-btn.is-danger{background:#b44a4a;color:#fff;border-color:#b44a4a}
            .chat-form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--border-color,#dee2e6);align-items:center}
            .chat-form input,.chat-form select{border:1px solid var(--border-color,#dee2e6);border-radius:6px;padding:9px 10px;background:var(--card-background,#fff);color:var(--text-color,#333)}
            .chat-form input{flex:1}
            .chat-form select{max-width:170px;display:none}
            .chat-panel.in-conversation .chat-form select{display:block}
            .user-presence-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
            .user-presence-dot.is-online{background:#1b8f3a}
            .user-presence-dot.is-offline{background:#b44a4a}
            @media (max-width:640px){.chat-panel{right:10px;left:10px;width:auto;bottom:66px;height:min(560px,72vh);max-height:72vh}}
        `;
        document.head.appendChild(style);

        const ensureModal = () => {
            if (document.getElementById('chatModalOverlay')) return;
            const modalWrapper = document.createElement('div');
            modalWrapper.innerHTML = `
                <div id="chatModalOverlay" class="chat-modal-overlay" aria-hidden="true">
                    <div class="chat-modal" role="dialog" aria-modal="true" aria-labelledby="chatModalTitle">
                        <h3 id="chatModalTitle">Confirmacao</h3>
                        <p id="chatModalMessage"></p>
                        <div class="chat-modal-actions">
                            <button id="chatModalCancel" class="chat-modal-btn" type="button">Cancelar</button>
                            <button id="chatModalConfirm" class="chat-modal-btn is-danger" type="button">Confirmar</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modalWrapper);
        };

        if (document.getElementById('chatFab')) {
            const chatPanel = document.getElementById('chatPanel');
            const chatContacts = document.getElementById('chatContacts');
            if (chatPanel && chatContacts && !document.getElementById('chatSearchInput')) {
                const wrap = document.createElement('div');
                wrap.className = 'chat-contacts-wrap';
                const search = document.createElement('div');
                search.className = 'chat-contacts-search';
                search.innerHTML = '<input id="chatSearchInput" type="search" placeholder="Buscar funcionario ou cliente">';
                chatContacts.parentNode.insertBefore(wrap, chatContacts);
                wrap.appendChild(search);
                wrap.appendChild(chatContacts);
            }
            ensureModal();
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <button id="chatFab" class="chat-fab" type="button" aria-label="Abrir chat">
                Chat
                <span id="chatUnreadBadge" class="chat-unread-badge" style="display:none;">0</span>
            </button>
            <section id="chatPanel" class="chat-panel" aria-label="Chat interno">
                <div class="chat-panel-header">
                    <div class="chat-header-left">
                        <button id="chatBackBtn" class="chat-back-btn" type="button" aria-label="Voltar"><</button>
                        <strong>Chat Interno <span id="chatTargetLabel">(Todos)</span></strong>
                    </div>
                    <div class="chat-header-actions">
                        <div class="chat-menu">
                            <button id="chatMenuBtn" class="chat-menu-trigger" type="button" aria-label="Mais opcoes">...</button>
                            <div id="chatMenuList" class="chat-menu-list">
                                <button id="chatClearSelfBtn" class="chat-menu-item" type="button">Apagar para mim</button>
                                <button id="chatDeleteBothBtn" class="chat-menu-item" type="button">Excluir conversa</button>
                            </div>
                        </div>
                        <button id="chatCloseBtn" class="chat-close-btn" type="button" aria-label="Fechar chat">x</button>
                    </div>
                </div>
                <div class="chat-contacts-wrap">
                    <div class="chat-contacts-search">
                        <input id="chatSearchInput" type="search" placeholder="Buscar funcionario ou cliente">
                    </div>
                    <div id="chatContacts" class="chat-contacts">
                        <div class="search-status">Carregando contatos...</div>
                    </div>
                </div>
                <div id="chatConversation" class="chat-conversation">
                    <div id="chatMessages" class="chat-messages">
                        <div class="search-status">Carregando mensagens...</div>
                    </div>
                    <form id="chatForm" class="chat-form">
                        <select id="chatTargetSelect" title="Destinatario"><option value="">Todos</option></select>
                        <button id="chatAttachBtn" class="chat-attach-btn" type="button" title="Anexar PNG, JPG ou PDF">[]</button>
                        <button id="chatDetachBtn" class="chat-detach-btn" type="button" title="Remover anexo" style="display:none;">x</button>
                        <input type="text" id="chatInput" maxlength="1000" placeholder="Digite uma mensagem..." autocomplete="off">
                        <button id="chatSendBtn" class="chat-send-btn" type="submit" title="Enviar mensagem">></button>
                    </form>
                </div>
            </section>
        `;
        document.body.appendChild(wrapper);
        ensureModal();
    }

    function el(id) {
        return document.getElementById(id);
    }

    function fecharChatModal(answer = false) {
        const overlay = el('chatModalOverlay');
        if (overlay) {
            overlay.classList.remove('active');
            overlay.setAttribute('aria-hidden', 'true');
        }
        if (chatModalResolver) {
            const resolver = chatModalResolver;
            chatModalResolver = null;
            resolver(answer);
        }
    }

    function abrirChatModal({ title, message, confirmText = 'Confirmar', cancelText = 'Cancelar', danger = false, hideCancel = false }) {
        const overlay = el('chatModalOverlay');
        const titleEl = el('chatModalTitle');
        const messageEl = el('chatModalMessage');
        const confirmBtn = el('chatModalConfirm');
        const cancelBtn = el('chatModalCancel');
        if (!overlay || !titleEl || !messageEl || !confirmBtn || !cancelBtn) {
            return Promise.resolve(false);
        }
        titleEl.textContent = title || 'Confirmacao';
        messageEl.textContent = message || '';
        confirmBtn.textContent = confirmText;
        cancelBtn.textContent = cancelText;
        confirmBtn.classList.toggle('is-danger', Boolean(danger));
        cancelBtn.style.display = hideCancel ? 'none' : '';
        overlay.classList.add('active');
        overlay.setAttribute('aria-hidden', 'false');
        return new Promise((resolve) => {
            chatModalResolver = resolve;
        });
    }

    function confirmarChatModal(message) {
        return abrirChatModal({
            title: 'Excluir conversa',
            message,
            confirmText: 'Excluir',
            cancelText: 'Cancelar',
            danger: true
        });
    }

    function avisarChatModal(message, title = 'Aviso') {
        return abrirChatModal({
            title,
            message,
            confirmText: 'OK',
            hideCancel: true,
            danger: false
        });
    }

    function renderChatUnread(unread) {
        const badge = el('chatUnreadBadge');
        const fab = el('chatFab');
        const panel = el('chatPanel');
        if (!badge) return;
        const total = Math.max(0, Number(unread) || 0);
        chatUnreadState = total;
        if (total <= 0) {
            badge.style.display = 'none';
            badge.textContent = '0';
            if (fab) fab.classList.remove('has-alert');
            return;
        }
        badge.style.display = 'inline-flex';
        badge.textContent = String(total > 99 ? '99+' : total);
        if (fab && !panel?.classList.contains('active')) fab.classList.add('has-alert');
    }

    function atualizarRotuloDestinoChat() {
        const label = el('chatTargetLabel');
        const select = el('chatTargetSelect');
        const deleteBtn = el('chatDeleteBothBtn');
        if (!label) return;
        const targetUser = String(select?.value || '').trim().toLowerCase();
        if (!targetUser) {
            label.textContent = '(Todos)';
            if (deleteBtn) deleteBtn.disabled = true;
            return;
        }
        const alvo = chatUsersState.find((item) => String(item?.username || '').toLowerCase() === targetUser);
        label.textContent = `(Para: ${String(alvo?.nome || alvo?.username || targetUser)})`;
        if (deleteBtn) deleteBtn.disabled = false;
    }

    function atualizarArquivoSelecionadoChat() {
        const attachBtn = el('chatAttachBtn');
        const detachBtn = el('chatDetachBtn');
        if (!attachBtn) return;
        if (!chatPendingAttachment) {
            attachBtn.textContent = '[]';
            if (detachBtn) detachBtn.style.display = 'none';
            return;
        }
        attachBtn.textContent = `[] ${String(chatPendingAttachment.name || '').slice(0, 10)}`;
        if (detachBtn) detachBtn.style.display = 'inline-flex';
    }

    function montarReciboMensagem(item, meuUser) {
        const fromUser = String(item?.from?.username || '').toLowerCase();
        if (fromUser !== meuUser) return '';
        const toUser = String(item?.to?.username || '').toLowerCase();
        const readBy = Array.isArray(item?.readBy) ? item.readBy.map((r) => String(r || '').toLowerCase()) : [];
        const receivedBy = Array.isArray(item?.receivedBy) ? item.receivedBy.map((r) => String(r || '').toLowerCase()) : [];
        if (toUser) {
            if (readBy.includes(toUser)) return '<span class="chat-receipt is-read" title="Visualizada">vv</span>';
            if (receivedBy.includes(toUser)) return '<span class="chat-receipt is-received" title="Recebida">v</span>';
            return '<span class="chat-receipt" title="Enviada">v</span>';
        }
        if (readBy.filter((u) => u && u !== meuUser).length > 0) return '<span class="chat-receipt is-read" title="Visualizada">vv</span>';
        if (receivedBy.filter((u) => u && u !== meuUser).length > 0) return '<span class="chat-receipt is-received" title="Recebida">v</span>';
        return '<span class="chat-receipt" title="Enviada">v</span>';
    }

    function definirModoChat(mode) {
        const panel = el('chatPanel');
        const conversation = el('chatConversation');
        const contactsWrap = document.querySelector('.chat-contacts-wrap');
        if (!panel) return;
        if (mode === 'conversation') {
            panel.classList.add('in-conversation');
            if (conversation) conversation.style.display = 'flex';
            if (contactsWrap) contactsWrap.style.display = 'none';
            return;
        }
        panel.classList.remove('in-conversation');
        if (conversation) conversation.style.display = 'none';
        if (contactsWrap) contactsWrap.style.display = 'block';
    }

    function obterConversaPrivada(username) {
        const meuUser = String(sessaoAtual?.username || '').toLowerCase();
        const alvo = String(username || '').toLowerCase();
        return chatState.filter((m) => {
            const from = String(m?.from?.username || '').toLowerCase();
            const to = String(m?.to?.username || '').toLowerCase();
            return Boolean(to) && ((from === meuUser && to === alvo) || (from === alvo && to === meuUser));
        });
    }

    async function excluirConversa(targetUsername) {
        const target = String(targetUsername || '').trim().toLowerCase();
        if (!target) return;
        if (!await confirmarChatModal('Excluir toda esta conversa para ambos?')) return;
        const result = await chatIpcRenderer.invoke('chat-delete-conversation-both', { targetUsername: target });
        if (!result?.ok) {
            await avisarChatModal(result?.message || 'Nao foi possivel excluir a conversa.');
            return;
        }
        if (el('chatTargetSelect') && String(el('chatTargetSelect').value || '').toLowerCase() === target) {
            el('chatTargetSelect').value = '';
            atualizarRotuloDestinoChat();
            definirModoChat('contacts');
        }
        await carregarChat();
    }

    function renderChatUsers() {
        const select = el('chatTargetSelect');
        if (!select) return;
        const atual = String(select.value || '').toLowerCase();
        const meuUser = String(sessaoAtual?.username || '').toLowerCase();
        const options = ['<option value="">Todos</option>'];
        const usernamesDisponiveis = new Set();
        chatUsersState
            .filter((item) => String(item?.username || '').toLowerCase() !== meuUser)
            .forEach((item) => {
                const username = String(item?.username || '').toLowerCase();
                usernamesDisponiveis.add(username);
                options.push(`<option value="${escapeHtml(username)}">${escapeHtml(item?.nome || item?.username || 'Usuario')} (@${escapeHtml(username)})</option>`);
            });
        select.innerHTML = options.join('');
        if (atual && usernamesDisponiveis.has(atual)) select.value = atual;
        atualizarRotuloDestinoChat();
    }

    function renderListaContatosChat() {
        const container = el('chatContacts');
        if (!container) return;

        const meuUser = String(sessaoAtual?.username || '').toLowerCase();
        const busca = normalizarBusca(chatSearchTerm);
        const contatosComConversa = chatUsersState
            .filter((u) => String(u?.username || '').toLowerCase() !== meuUser)
            .map((u) => {
                const username = String(u?.username || '').toLowerCase();
                const privadas = obterConversaPrivada(username);
                const ultima = privadas[privadas.length - 1];
                return {
                    username,
                    nome: String(u?.nome || u?.username || username),
                    hasConversation: privadas.length > 0,
                    preview: ultima ? resumirMensagemChat(ultima) : 'Sem mensagens privadas'
                };
            });

        const contatos = busca
            ? contatosComConversa.filter((c) => {
                const alvo = normalizarBusca(`${c.nome} ${c.username}`);
                return alvo.includes(busca);
            })
            : contatosComConversa.filter((c) => c.hasConversation);

        if (contatos.length === 0) {
            container.innerHTML = busca
                ? '<div class="search-status">Nenhum funcionario ou cliente encontrado.</div>'
                : '<div class="search-status">Nenhuma conversa privada ativa.</div>';
            return;
        }

        container.innerHTML = contatos.map((c) => {
            const uname = String(c.username || '').toLowerCase();
            const online = chatOnlineUsersSet.has(uname);
            const dotClass = online ? 'is-online' : 'is-offline';
            return `
                <div class="chat-contact-item">
                    <button type="button" class="chat-contact-main" data-chat-contact="${escapeHtml(uname)}">
                        <div class="chat-contact-title"><span class="user-presence-dot ${dotClass}"></span>${escapeHtml(c.nome)}</div>
                        <div class="chat-contact-preview">${escapeHtml(c.preview || '')}</div>
                    </button>
                    ${c.hasConversation ? `<button type="button" class="chat-contact-delete" data-chat-contact-delete="${escapeHtml(uname)}" title="Excluir conversa">🗑</button>` : ''}
                </div>
            `;
        }).join('');

        container.querySelectorAll('[data-chat-contact]').forEach((button) => {
            button.addEventListener('click', () => {
                const target = String(button.getAttribute('data-chat-contact') || '').toLowerCase();
                if (el('chatTargetSelect')) el('chatTargetSelect').value = target;
                atualizarRotuloDestinoChat();
                renderChatMessages(chatState);
                definirModoChat('conversation');
                if (el('chatInput')) setTimeout(() => el('chatInput').focus(), 0);
            });
        });

        container.querySelectorAll('[data-chat-contact-delete]').forEach((button) => {
            button.addEventListener('click', async (event) => {
                event.stopPropagation();
                await excluirConversa(button.getAttribute('data-chat-contact-delete'));
            });
        });
    }

    function renderChatMessages(messages) {
        const container = el('chatMessages');
        if (!container) return;
        const meuUser = String(sessaoAtual?.username || '').toLowerCase();
        const targetUser = String(el('chatTargetSelect')?.value || '').trim().toLowerCase();
        const lista = targetUser
            ? (Array.isArray(messages) ? messages : []).filter((item) => {
                const fromUser = String(item?.from?.username || '').toLowerCase();
                const toUser = String(item?.to?.username || '').toLowerCase();
                return Boolean(toUser) && ((fromUser === meuUser && toUser === targetUser) || (fromUser === targetUser && toUser === meuUser));
            })
            : (Array.isArray(messages) ? messages : []).filter((item) => !String(item?.to?.username || '').trim());

        if (lista.length === 0) {
            container.innerHTML = targetUser
                ? '<div class="search-status">Sem mensagens privadas com este usuario.</div>'
                : '<div class="search-status">Nenhuma mensagem ainda.</div>';
            return;
        }

        container.innerHTML = lista.map((item) => {
            const fromUser = String(item?.from?.username || '').toLowerCase();
            const toUsername = String(item?.to?.username || '').toLowerCase();
            const toNome = escapeHtml(item?.to?.nome || item?.to?.username || '');
            const isMe = fromUser === meuUser;
            const fromOnline = isMe || chatOnlineUsersSet.has(fromUser);
            const attachment = (item?.attachment && typeof item.attachment === 'object') ? item.attachment : null;
            return `
                <div class="chat-message ${isMe ? 'is-me' : ''}">
                    <div class="chat-message-meta"><span class="user-presence-dot ${fromOnline ? 'is-online' : 'is-offline'}"></span><strong>${escapeHtml(item?.from?.nome || item?.from?.username || 'Usuario')}</strong> • ${escapeHtml(formatDateTime(item?.at))}${toUsername ? ` • privado ${toNome ? `para ${toNome}` : ''}` : ''}</div>
                    <div class="chat-message-text">${escapeHtml(item?.text || '')}</div>
                    ${attachment?.path ? `<div class="chat-attachment">${String(attachment?.kind || '').toLowerCase() === 'image'
                        ? `<button class="chat-open-file" type="button" data-file-path="${escapeHtml(attachment.path)}">Abrir imagem: ${escapeHtml(attachment.name || 'imagem')}</button>`
                        : `<button class="chat-open-file" type="button" data-file-path="${escapeHtml(attachment.path)}">Abrir PDF: ${escapeHtml(attachment.name || 'arquivo.pdf')}</button>`} <span class="users-item-meta">(${escapeHtml(formatBytes(attachment.size || 0))})</span></div>` : ''}
                    <div class="chat-message-footer">
                        <span>${montarReciboMensagem(item, meuUser)}</span>
                        ${isMe ? `<button class="chat-message-delete" type="button" data-chat-delete-id="${escapeHtml(item?.id || '')}">Excluir</button>` : '<span></span>'}
                    </div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.chat-open-file').forEach((button) => {
            button.addEventListener('click', async () => {
                const filePath = String(button.getAttribute('data-file-path') || '').trim();
                if (!filePath) return;
                await chatIpcRenderer.invoke('chat-open-file', { path: filePath });
            });
        });

        container.querySelectorAll('[data-chat-delete-id]').forEach((button) => {
            button.addEventListener('click', async () => {
                const id = String(button.getAttribute('data-chat-delete-id') || '').trim();
                if (!id || !await confirmarChatModal('Excluir esta mensagem para ambos?')) return;
                const result = await chatIpcRenderer.invoke('chat-delete-message', { id, mode: 'both' });
                if (!result?.ok) return;
                await carregarChat();
            });
        });

        container.scrollTop = container.scrollHeight;
    }

    async function carregarUsuariosChat() {
        const result = await chatIpcRenderer.invoke('chat-users');
        chatUsersState = result?.ok && Array.isArray(result.users) ? result.users : [];
        renderChatUsers();
        renderListaContatosChat();
    }

    async function carregarUsuariosOnlineChat() {
        const meuUser = String(sessaoAtual?.username || '').toLowerCase();
        const result = await chatIpcRenderer.invoke('auth-list-online-users');
        const usernames = result?.ok && Array.isArray(result.usernames) ? result.usernames : [];
        const base = usernames.map((u) => String(u || '').toLowerCase()).filter(Boolean);
        if (meuUser) base.push(meuUser);
        chatOnlineUsersSet = new Set(base);
        renderListaContatosChat();
    }

    async function carregarChat() {
        if (!sessaoAtual) return;
        const panel = el('chatPanel');
        const result = await chatIpcRenderer.invoke('chat-list', { limit: 200 });
        if (!result?.ok) {
            if (el('chatMessages')) el('chatMessages').innerHTML = `<div class="search-status">${escapeHtml(result?.message || 'Erro ao carregar chat.')}</div>`;
            return;
        }
        chatState = Array.isArray(result.messages) ? result.messages : [];
        renderListaContatosChat();
        renderChatMessages(chatState);
        const unread = Number(result.unread) || 0;
        const unreadAnterior = chatUnreadState;
        renderChatUnread(unread);
        if (unread > unreadAnterior && !panel?.classList.contains('active')) tocarSomNovaMensagem();
        if (panel?.classList.contains('active') && unread > 0) {
            await chatIpcRenderer.invoke('chat-mark-read', { all: true });
            renderChatUnread(0);
        }
    }

    async function enviarMensagemChat() {
        const text = String(el('chatInput')?.value || '').trim();
        if (!text && !chatPendingAttachment) return;
        const result = await chatIpcRenderer.invoke('chat-send', {
            text,
            toUsername: String(el('chatTargetSelect')?.value || '').trim().toLowerCase(),
            attachment: chatPendingAttachment || null
        });
        if (!result?.ok) return;
        if (el('chatInput')) el('chatInput').value = '';
        chatPendingAttachment = null;
        atualizarArquivoSelecionadoChat();
        await carregarChat();
    }

    function abrirChat() {
        if (!el('chatPanel')) return;
        el('chatPanel').classList.add('active');
        definirModoChat('contacts');
        renderListaContatosChat();
        if (el('chatFab')) el('chatFab').classList.remove('has-alert');
        carregarChat().then(() => chatIpcRenderer.invoke('chat-mark-read', { all: true })).catch(() => {});
    }

    function fecharMenuChat() {
        if (el('chatMenuList')) el('chatMenuList').classList.remove('active');
    }

    function fecharChat() {
        if (!el('chatPanel')) return;
        el('chatPanel').classList.remove('active');
        fecharMenuChat();
    }

    function bindEvents() {
        el('chatFab')?.addEventListener('click', () => {
            if (!el('chatPanel')?.classList.contains('active')) abrirChat();
            else fecharChat();
        });

        el('chatCloseBtn')?.addEventListener('click', fecharChat);
        el('chatBackBtn')?.addEventListener('click', () => {
            definirModoChat('contacts');
            fecharMenuChat();
        });
        el('chatMenuBtn')?.addEventListener('click', (event) => {
            event.stopPropagation();
            el('chatMenuList')?.classList.toggle('active');
        });
        el('chatForm')?.addEventListener('submit', async (event) => {
            event.preventDefault();
            await enviarMensagemChat();
        });
        el('chatAttachBtn')?.addEventListener('click', async () => {
            const result = await chatIpcRenderer.invoke('chat-pick-file');
            if (!result?.ok || !result.attachment) return;
            chatPendingAttachment = result.attachment;
            atualizarArquivoSelecionadoChat();
        });
        el('chatDetachBtn')?.addEventListener('click', () => {
            chatPendingAttachment = null;
            atualizarArquivoSelecionadoChat();
        });
        el('chatClearSelfBtn')?.addEventListener('click', async () => {
            fecharMenuChat();
            const targetUsername = String(el('chatTargetSelect')?.value || '').trim().toLowerCase();
            const msg = targetUsername ? 'Limpar esta conversa privada somente para voce?' : 'Limpar o chat publico somente para voce?';
            if (!await confirmarChatModal(msg)) return;
            const result = await chatIpcRenderer.invoke('chat-clear-conversation-self', { targetUsername });
            if (!result?.ok) return;
            await carregarChat();
        });
        el('chatDeleteBothBtn')?.addEventListener('click', async () => {
            fecharMenuChat();
            await excluirConversa(el('chatTargetSelect')?.value || '');
        });
        el('chatTargetSelect')?.addEventListener('change', () => {
            fecharMenuChat();
            atualizarRotuloDestinoChat();
            renderChatMessages(chatState);
        });
        el('chatSearchInput')?.addEventListener('input', (event) => {
            chatSearchTerm = String(event.target.value || '');
            renderListaContatosChat();
        });
        document.addEventListener('click', (event) => {
            if (!el('chatMenuList')?.classList.contains('active')) return;
            const alvo = event.target;
            if (el('chatMenuBtn')?.contains(alvo) || el('chatMenuList')?.contains(alvo)) return;
            fecharMenuChat();
        });
        el('chatModalConfirm')?.addEventListener('click', () => fecharChatModal(true));
        el('chatModalCancel')?.addEventListener('click', () => fecharChatModal(false));
        el('chatModalOverlay')?.addEventListener('click', (event) => {
            if (event.target === el('chatModalOverlay')) fecharChatModal(false);
        });
        window.addEventListener('beforeunload', () => {
            if (chatPollTimer) clearInterval(chatPollTimer);
        });
    }

    async function iniciar() {
        renderWidget();
        bindEvents();
        sessaoAtual = await chatIpcRenderer.invoke('auth-get-session');
        if (!sessaoAtual) return;
        await carregarUsuariosChat();
        await carregarUsuariosOnlineChat();
        await carregarChat();
        if (chatPollTimer) clearInterval(chatPollTimer);
        chatPollTimer = setInterval(() => {
            Promise.all([carregarChat(), carregarUsuariosChat(), carregarUsuariosOnlineChat()]).catch((error) => {
                console.error('Erro ao atualizar chat:', error);
            });
        }, 5000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            iniciar().catch((error) => console.error('Falha ao iniciar chat:', error));
        }, { once: true });
        return;
    }

    iniciar().catch((error) => console.error('Falha ao iniciar chat:', error));
})();
