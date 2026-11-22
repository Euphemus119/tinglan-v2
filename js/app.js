/* 听澜 2 · 阶段 1：骨架 + 流式对话
   这一阶段刻意不做的：角色卡、预设、分支、导出、自动推送（后续阶段再加）。
   但数据结构已经按「树」设计：每条消息都有 parentId，第 3 阶段加分支时不用返工。
*/
'use strict';

(function () {
    const $ = function (id) { return document.getElementById(id); };
    const LS_KEY = 'tl2_api_key';
    const LS_THEME = 'tl2_theme';
    const LS_PRESETS = 'tl2_presets';
    const LS_ACTIVE_PRESET = 'tl2_active_preset';
    const LS_BEHAVIOR = 'tl2_behavior';
    const LS_AUTOPUSH = 'tl2_autopush';
    const CTX_CHAR_LIMIT = 90000;

    const state = {
        sessions: [],
        session: null,
        messages: [],
        path: [],
        leafId: null,
        streaming: false,
        controller: null,
        suppressAbortToast: false,
        cardTab: 'ai',
        templates: [],
        templateKind: null,
        settings: { presets: [], activePresetId: '', behavior: '' },
        search: '',
        searchMatches: new Map(),
        bg: { blob: null, url: '', opacity: 16, blur: 2 },
        bgTemp: null,
        autoPush: { enabled: false, minutes: 20, pauseStart: 23, pauseEnd: 8, max: 2 },
        autoPushTimer: null,
        autoPushCount: 0,
        lastActivity: Date.now(),
        editingNodeId: null
    };

    const els = {};

    // ==================== 小工具 ====================

    function newId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function h(tag, cls, text) {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (text !== undefined && text !== null) el.textContent = text;
        return el;
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** 极简 Markdown：粗体、斜体、行内代码、代码块、分隔线。先转义再替换，杜绝注入。 */
    function renderMarkdown(raw) {
        let text = escapeHtml(raw || '');
        const blocks = [];
        text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, function (m, code) {
            blocks.push('<pre><code>' + code.replace(/\n$/, '') + '</code></pre>');
            return '\u0000' + (blocks.length - 1) + '\u0000';
        });
        text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
        text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
        text = text.replace(/^---+$/gm, '<hr>');
        text = text.replace(/\u0000(\d+)\u0000/g, function (m, i) { return blocks[Number(i)] || ''; });
        return text;
    }

    function toast(message, kind) {
        els.toast.textContent = message;
        els.toast.className = 'toast show' + (kind === 'error' ? ' error' : '');
        clearTimeout(toast._timer);
        toast._timer = setTimeout(function () { els.toast.className = 'toast'; }, kind === 'error' ? 5200 : 2400);
    }

    function isCoarsePointer() {
        return window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    }

    // ==================== 主题 ====================

    function applyTheme() {
        const saved = localStorage.getItem(LS_THEME);
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const dark = saved ? saved === 'dark' : prefersDark;
        document.body.dataset.theme = dark ? 'dark' : 'light';
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', dark ? '#101114' : '#f6f7f9');
    }

    function toggleTheme() {
        const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
        document.body.dataset.theme = next;
        localStorage.setItem(LS_THEME, next);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', next === 'dark' ? '#101114' : '#f6f7f9');
    }

    // ==================== 预设 / 行为准则 ====================

    const PRESET_FIELDS = ['writing', 'dialogue', 'theme', 'bannedWords', 'taboos', 'auxiliary'];
    const PRESET_INPUT_IDS = {
        writing: 'p-writing',
        dialogue: 'p-dialogue',
        theme: 'p-theme',
        bannedWords: 'p-banned',
        taboos: 'p-taboos',
        auxiliary: 'p-aux'
    };

    function normalizePreset(preset) {
        const out = {
            id: (preset && preset.id) || newId(),
            name: (preset && preset.name) || '未命名预设'
        };
        PRESET_FIELDS.forEach(function (key) {
            out[key] = (preset && typeof preset[key] === 'string') ? preset[key] : '';
        });
        return out;
    }

    function loadSettings() {
        let presets = null;
        try { presets = JSON.parse(localStorage.getItem(LS_PRESETS) || 'null'); } catch (err) { presets = null; }
        if (!Array.isArray(presets) || !presets.length) presets = Prompt.defaultPresets();
        state.settings.presets = presets.map(normalizePreset);

        const savedActive = localStorage.getItem(LS_ACTIVE_PRESET);
        state.settings.activePresetId = state.settings.presets.some(function (p) { return p.id === savedActive; })
            ? savedActive
            : state.settings.presets[0].id;

        const savedBehavior = localStorage.getItem(LS_BEHAVIOR);
        state.settings.behavior = savedBehavior === null ? Prompt.DEFAULT_BEHAVIOR : savedBehavior;
        saveSettings();
    }

    function saveSettings() {
        localStorage.setItem(LS_PRESETS, JSON.stringify(state.settings.presets));
        localStorage.setItem(LS_ACTIVE_PRESET, state.settings.activePresetId || '');
        localStorage.setItem(LS_BEHAVIOR, state.settings.behavior);
    }

    function activePreset() {
        return state.settings.presets.find(function (p) { return p.id === state.settings.activePresetId; }) || state.settings.presets[0];
    }

    function currentSystemPrompt() {
        return Prompt.build(state.session, { preset: activePreset(), behavior: state.settings.behavior });
    }

    function openPresetDialog() {
        renderPresetSelect();
        fillPresetForm(activePreset());
        els.presetDialog.hidden = false;
        closeSidebar();
    }

    function renderPresetSelect() {
        const select = els.presetSelect;
        select.innerHTML = '';
        state.settings.presets.forEach(function (preset) {
            const option = document.createElement('option');
            option.value = preset.id;
            option.textContent = preset.name;
            if (preset.id === state.settings.activePresetId) option.selected = true;
            select.appendChild(option);
        });
    }

    function fillPresetForm(preset) {
        PRESET_FIELDS.forEach(function (key) {
            const input = document.getElementById(PRESET_INPUT_IDS[key]);
            if (input) input.value = (preset && preset[key]) || '';
        });
    }

    function readPresetForm() {
        const out = {};
        PRESET_FIELDS.forEach(function (key) {
            const input = document.getElementById(PRESET_INPUT_IDS[key]);
            out[key] = input ? String(input.value || '').trim() : '';
        });
        return out;
    }

    function onPresetChange() {
        const previous = activePreset();
        if (previous && els.presetSelect.value !== previous.id) {
            Object.assign(previous, readPresetForm());
        }
        state.settings.activePresetId = els.presetSelect.value;
        saveSettings();
        fillPresetForm(activePreset());
        updateHeader();
    }

    function newPreset() {
        const name = window.prompt('新预设名称（例如：角色扮演 / 小说创作）：', '新预设');
        if (name === null) return;
        const preset = normalizePreset({ id: newId(), name: name.trim() || '新预设' });
        Object.assign(preset, readPresetForm());
        state.settings.presets.push(preset);
        state.settings.activePresetId = preset.id;
        saveSettings();
        renderPresetSelect();
        fillPresetForm(preset);
        updateHeader();
        toast('已新建预设');
    }

    function renamePreset() {
        const preset = activePreset();
        if (!preset) return;
        const name = window.prompt('修改预设名称：', preset.name);
        if (name === null || !name.trim()) return;
        preset.name = name.trim();
        saveSettings();
        renderPresetSelect();
        fillPresetForm(preset);
        updateHeader();
    }

    function deletePreset() {
        if (state.settings.presets.length <= 1) { toast('至少保留一个预设', 'error'); return; }
        const preset = activePreset();
        if (!preset) return;
        if (!window.confirm('删除预设「' + preset.name + '」？')) return;
        state.settings.presets = state.settings.presets.filter(function (p) { return p.id !== preset.id; });
        state.settings.activePresetId = state.settings.presets[0].id;
        saveSettings();
        renderPresetSelect();
        fillPresetForm(activePreset());
        updateHeader();
    }

    function savePresetDialog() {
        const preset = activePreset();
        if (!preset) return;
        Object.assign(preset, readPresetForm());
        saveSettings();
        els.presetDialog.hidden = true;
        updateHeader();
        toast('预设已保存');
    }

    function openBehaviorDialog() {
        els.behaviorText.value = state.settings.behavior;
        els.behaviorDialog.hidden = false;
        closeSidebar();
    }

    function saveBehaviorDialog() {
        const text = els.behaviorText.value.trim();
        state.settings.behavior = text || Prompt.DEFAULT_BEHAVIOR;
        saveSettings();
        els.behaviorDialog.hidden = true;
        toast('行为准则已保存');
    }

    function resetBehavior() {
        els.behaviorText.value = Prompt.DEFAULT_BEHAVIOR;
    }

    // ==================== API Key ====================

    function getKey() { return localStorage.getItem(LS_KEY) || ''; }

    function openKeyDialog() {
        els.keyInput.value = getKey();
        els.keyDialog.hidden = false;
        setTimeout(function () { els.keyInput.focus(); }, 30);
    }

    function closeKeyDialog() { els.keyDialog.hidden = true; }

    function saveKey() {
        const key = els.keyInput.value.trim();
        if (!/^sk-[^\s]{8,}$/.test(key)) { toast('Key 格式不对，应该以 sk- 开头', 'error'); return; }
        localStorage.setItem(LS_KEY, key);
        closeKeyDialog();
        toast('API Key 已保存');
    }

    // ==================== 角色卡 / 故事背景 ====================

    const CARD_DEFS = [
        { key: 'name', label: '姓名', type: 'input', ph: '例如：沈炼' },
        { key: 'gender', label: '性别', type: 'input', ph: '男 / 女 / 其他' },
        { key: 'age', label: '年龄', type: 'input', ph: '例如：28' },
        { key: 'identity', label: '身份', type: 'input', ph: '例如：锦衣卫百户' },
        { key: 'appearance', label: '外貌', type: 'textarea', ph: '例如：剑眉星目，左手有一道旧疤' },
        { key: 'personality', label: '性格', type: 'textarea', ph: '例如：话少，但句句关键' },
        { key: 'core', label: '核心人格', type: 'textarea', ph: '例如：护短、认死理' },
        { key: 'backstory', label: '人物经历', type: 'textarea', ph: '他经历过什么' },
        { key: 'attitude', label: '感情与态度', type: 'textarea', ph: '对对方的感情、态度、称呼' },
        { key: 'extra', label: '补充设定', type: 'textarea', ph: '口癖、习惯、弱点、禁忌……' }
    ];

    const SCENE_DEFS = [
        { key: 'world', label: '世界观', type: 'textarea', ph: '这是一个什么样的世界' },
        { key: 'plot', label: '前置剧情', type: 'textarea', ph: '在对话开始前发生过什么' },
        { key: 'opening', label: '开场场景', type: 'textarea', ph: '此刻在哪里、什么时间、什么气氛' }
    ];

    function buildFields(container, prefix, defs) {
        if (!container) return;
        defs.forEach(function (def) {
            const row = h('div', 'form-row');
            const label = h('label', '', def.label);
            label.setAttribute('for', prefix + '-' + def.key);
            const input = def.type === 'textarea' ? h('textarea') : h('input');
            input.id = prefix + '-' + def.key;
            if (def.ph) input.placeholder = def.ph;
            if (def.type === 'textarea') input.rows = def.rows || 2;
            row.appendChild(label);
            row.appendChild(input);
            container.appendChild(row);
        });
    }

    function buildCardPanel(panel, prefix, kind) {
        if (!panel) return;
        buildFields(panel, prefix, CARD_DEFS);
        const actions = h('div', 'panel-actions');
        const fromTemplate = h('button', 'btn ghost', '从模板载入');
        fromTemplate.type = 'button';
        fromTemplate.addEventListener('click', function () { openTemplates(kind); });
        const saveTemplateBtn = h('button', 'btn ghost', '保存为模板');
        saveTemplateBtn.type = 'button';
        saveTemplateBtn.addEventListener('click', function () { saveTemplate(kind); });
        actions.appendChild(fromTemplate);
        actions.appendChild(saveTemplateBtn);
        panel.appendChild(actions);
    }

    function buildCardForms() {
        buildCardPanel(document.getElementById('panel-ai'), 'ai', 'ai');
        buildCardPanel(document.getElementById('panel-me'), 'me', 'me');
        buildFields(document.getElementById('panel-scene'), 'sc', SCENE_DEFS);
    }

    function readFields(prefix, defs) {
        const out = {};
        defs.forEach(function (def) {
            const input = document.getElementById(prefix + '-' + def.key);
            out[def.key] = input ? String(input.value || '').trim() : '';
        });
        return out;
    }

    function fillFields(prefix, defs, data) {
        defs.forEach(function (def) {
            const input = document.getElementById(prefix + '-' + def.key);
            if (input) input.value = (data && data[def.key]) || '';
        });
    }

    function setCardTab(tab) {
        state.cardTab = tab;
        Array.prototype.forEach.call(els.cardTabs.children, function (button) {
            button.classList.toggle('active', button.dataset.tab === tab);
        });
        ['ai', 'me', 'scene'].forEach(function (name) {
            const panel = document.getElementById('panel-' + name);
            if (panel) panel.hidden = name !== tab;
        });
    }

    function openCardDialog(tab) {
        if (!state.session) return;
        fillFields('ai', CARD_DEFS, state.session.aiCard || {});
        fillFields('me', CARD_DEFS, state.session.userCard || {});
        fillFields('sc', SCENE_DEFS, state.session.scene || {});
        setCardTab(tab === 'me' || tab === 'scene' ? tab : 'ai');
        els.cardDialog.hidden = false;
        closeSidebar();
    }

    function saveCardDialog() {
        if (!state.session) return;
        state.session.aiCard = readFields('ai', CARD_DEFS);
        state.session.userCard = readFields('me', CARD_DEFS);
        state.session.scene = readFields('sc', SCENE_DEFS);

        if (state.session.aiCard.name && (!state.session.title || state.session.title === '新对话')) {
            state.session.title = state.session.aiCard.name;
        }

        persistSession(state.session);
        updateHeader();
        renderSessionList();
        els.cardDialog.hidden = true;
        toast('设定已保存');
    }

    function clearCardPage() {
        const map = {
            ai: ['ai', CARD_DEFS],
            me: ['me', CARD_DEFS],
            scene: ['sc', SCENE_DEFS]
        };
        const current = map[state.cardTab] || map.ai;
        if (!window.confirm('清空这一页的设定？')) return;
        fillFields(current[0], current[1], {});
        toast('已清空，点「保存」后生效');
    }

    // ==================== 角色模板库 ====================

    async function openTemplates(kind) {
        state.templateKind = kind || null;
        try {
            state.templates = await Store.listCards(kind || undefined);
        } catch (err) {
            state.templates = [];
            toast('读取模板失败：' + err.message, 'error');
        }
        renderTemplateList();
        els.templateDialog.hidden = false;
        closeSidebar();
    }

    function renderTemplateList() {
        els.templateList.innerHTML = '';
        if (!state.templates.length) {
            els.templateList.appendChild(h('div', 'template-empty', '还没有模板。在角色面板里填好内容，点「保存为模板」。'));
            return;
        }
        state.templates.forEach(function (template) {
            const row = h('div', 'template-row');
            row.appendChild(h('span', 'badge', template.kind === 'me' ? '我的角色' : 'AI 角色'));
            row.appendChild(h('span', 'name', template.name || (template.card && template.card.name) || '未命名'));

            const load = h('button', 'tool-btn', '载入');
            load.type = 'button';
            load.addEventListener('click', function () { applyTemplate(template); });

            const del = h('button', 'tool-btn', '删除');
            del.type = 'button';
            del.addEventListener('click', function () { deleteTemplate(template); });

            row.appendChild(load);
            row.appendChild(del);
            els.templateList.appendChild(row);
        });
    }

    function applyTemplate(template) {
        const prefix = template.kind === 'me' ? 'me' : 'ai';
        fillFields(prefix, CARD_DEFS, template.card || {});
        setCardTab(template.kind === 'me' ? 'me' : 'ai');
        els.templateDialog.hidden = true;
        els.cardDialog.hidden = false;
        toast('已填入，记得点「保存」');
    }

    function saveTemplate(kind) {
        const card = readFields(kind, CARD_DEFS);
        if (!card.name) { toast('先填姓名，再保存为模板', 'error'); return; }
        Store.putCard({
            id: newId(),
            kind: kind,
            name: card.name,
            card: card,
            updatedAt: Date.now()
        }).then(function () {
            toast('已保存到模板库');
        }).catch(function (err) {
            toast('保存模板失败：' + err.message, 'error');
        });
    }

    async function deleteTemplate(template) {
        if (!window.confirm('删除模板「' + (template.name || '未命名') + '」？')) return;
        try {
            await Store.deleteCard(template.id);
            state.templates = await Store.listCards(state.templateKind || undefined);
            renderTemplateList();
            toast('模板已删除');
        } catch (err) {
            toast('删除失败：' + err.message, 'error');
        }
    }

    // ==================== 设置面板 ====================

    function openSettings() {
        refreshSettingsHints();
        els.settingsDialog.hidden = false;
        closeSidebar();
    }

    function refreshSettingsHints() {
        els.bgState.textContent = state.bg.blob ? '已设置' : '未设置';
        els.apState.textContent = state.autoPush.enabled
            ? '已开启 · 沉默 ' + state.autoPush.minutes + ' 分钟'
            : '已关闭';
        els.themeState.textContent = document.body.dataset.theme === 'dark' ? '深色' : '浅色';
        els.keyState.textContent = getKey() ? '已设置' : '未设置';
    }

    // ==================== 聊天背景 ====================

    async function loadBackground() {
        try {
            const saved = await Store.getSetting('background');
            if (saved && saved.blob) {
                state.bg.blob = saved.blob;
                state.bg.opacity = saved.opacity || 16;
                state.bg.blur = saved.blur || 2;
            }
        } catch (err) { /* 背景坏了不影响聊天 */ }
        applyBackground();
    }

    function applyBackground() {
        if (state.bg.url) { URL.revokeObjectURL(state.bg.url); state.bg.url = ''; }
        if (state.bg.blob) {
            state.bg.url = URL.createObjectURL(state.bg.blob);
            els.bgLayer.style.backgroundImage = 'url(' + state.bg.url + ')';
            els.bgLayer.style.opacity = String(state.bg.opacity / 100);
            els.bgLayer.style.filter = 'blur(' + state.bg.blur + 'px)';
            els.bgLayer.hidden = false;
        } else {
            els.bgLayer.style.backgroundImage = 'none';
            els.bgLayer.hidden = true;
        }
    }

    function openBgDialog() {
        state.bgTemp = { blob: state.bg.blob, opacity: state.bg.opacity, blur: state.bg.blur, url: '' };
        els.bgOpacity.value = state.bg.opacity;
        els.bgBlur.value = state.bg.blur;
        updateBgPreview();
        els.bgDialog.hidden = false;
    }

    function updateBgPreview() {
        const opacity = parseInt(els.bgOpacity.value, 10) || 16;
        const blur = parseInt(els.bgBlur.value, 10) || 0;
        els.bgOpacityVal.textContent = opacity + '%';
        els.bgBlurVal.textContent = blur + 'px';
        const temp = state.bgTemp;
        if (temp.url) { URL.revokeObjectURL(temp.url); temp.url = ''; }
        if (temp.blob) {
            temp.url = URL.createObjectURL(temp.blob);
            els.bgPreviewImg.style.backgroundImage = 'url(' + temp.url + ')';
            els.bgPreviewImg.style.opacity = String(opacity / 100);
            els.bgPreviewImg.style.filter = 'blur(' + blur + 'px)';
            els.bgPreviewText.textContent = '';
        } else {
            els.bgPreviewImg.style.backgroundImage = 'none';
            els.bgPreviewText.textContent = '暂无背景';
        }
    }

    function handleBgFile(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        if (!/^image\//.test(file.type)) { toast('请选择图片文件', 'error'); return; }
        state.bgTemp.blob = file;
        updateBgPreview();
        event.target.value = '';
    }

    async function saveBgDialog() {
        const opacity = parseInt(els.bgOpacity.value, 10) || 16;
        const blur = parseInt(els.bgBlur.value, 10) || 0;
        state.bg.blob = state.bgTemp.blob;
        state.bg.opacity = opacity;
        state.bg.blur = blur;
        try {
            if (state.bg.blob) {
                await Store.putSetting({ key: 'background', blob: state.bg.blob, opacity: opacity, blur: blur });
            } else {
                await Store.deleteSetting('background');
            }
        } catch (err) {
            toast('保存背景失败：' + err.message, 'error');
            return;
        }
        applyBackground();
        els.bgDialog.hidden = true;
        refreshSettingsHints();
        toast('背景已保存');
    }

    async function removeBg() {
        state.bgTemp.blob = null;
        updateBgPreview();
        state.bg.blob = null;
        try { await Store.deleteSetting('background'); } catch (err) { /* 忽略 */ }
        applyBackground();
        refreshSettingsHints();
        toast('背景已移除');
    }

    // ==================== 角色主动性 ====================

    function loadAutoPushSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(LS_AUTOPUSH) || 'null');
            if (saved && typeof saved === 'object') Object.assign(state.autoPush, saved);
        } catch (err) { /* 用默认值 */ }
    }

    function saveAutoPushSettings() {
        localStorage.setItem(LS_AUTOPUSH, JSON.stringify(state.autoPush));
    }

    function openAutoPushDialog() {
        els.apEnabled.checked = !!state.autoPush.enabled;
        els.apInterval.value = state.autoPush.minutes;
        els.apIntervalVal.textContent = state.autoPush.minutes + ' 分钟';
        els.apMax.value = state.autoPush.max;
        els.apMaxVal.textContent = '最多 ' + state.autoPush.max + ' 句';
        els.apPauseStart.value = state.autoPush.pauseStart;
        els.apPauseEnd.value = state.autoPush.pauseEnd;
        els.autoPushDialog.hidden = false;
    }

    function saveAutoPushDialog() {
        state.autoPush = {
            enabled: !!els.apEnabled.checked,
            minutes: Math.max(1, parseInt(els.apInterval.value, 10) || 20),
            max: Math.max(1, parseInt(els.apMax.value, 10) || 2),
            pauseStart: Math.min(23, Math.max(0, parseInt(els.apPauseStart.value, 10) || 0)),
            pauseEnd: Math.min(23, Math.max(0, parseInt(els.apPauseEnd.value, 10) || 0))
        };
        saveAutoPushSettings();
        startAutoPushTimer();
        els.autoPushDialog.hidden = true;
        refreshSettingsHints();
        toast(state.autoPush.enabled ? '角色主动性已开启' : '角色主动性已关闭');
    }

    function startAutoPushTimer() {
        if (state.autoPushTimer) clearInterval(state.autoPushTimer);
        state.autoPushTimer = setInterval(autoPushTick, 20000);
    }

    function inPausePeriod() {
        const hour = new Date().getHours();
        const start = state.autoPush.pauseStart;
        const end = state.autoPush.pauseEnd;
        return start <= end ? (hour >= start && hour < end) : (hour >= start || hour < end);
    }

    function autoPushTick() {
        const cfg = state.autoPush;
        if (!cfg.enabled) return;
        if (document.visibilityState && document.visibilityState !== 'visible') return;
        if (state.streaming || !state.session || !getKey()) return;
        if (!state.session.aiCard || !state.session.aiCard.name) return;
        if (!state.path.length) return;
        const last = state.path[state.path.length - 1];
        if (last.role !== 'assistant') return;
        if (state.autoPushCount >= cfg.max) return;
        if (inPausePeriod()) return;
        if (els.input.value.trim()) return;
        if (Date.now() - state.lastActivity < cfg.minutes * 60000) return;
        performAutoPush();
    }

    async function performAutoPush() {
        if (state.streaming || !state.session) return;
        const base = currentSystemPrompt();
        const instruction = [
            '【此刻的任务】',
            '对话已经沉默了一段时间。请以你扮演的角色的身份，主动做一个小动作或说一句短话，推动剧情或流露情绪。',
            '不要询问对方在不在，不要解释自己，不要总结前文。'
        ].join('\n');
        const systemPrompt = (base ? base + '\n\n' : '') + instruction;
        await generateReply(state.session, state.leafId, state.path, { systemPrompt: systemPrompt, auto: true });
    }

    // ==================== 导出 ====================

    function downloadFile(filename, content, mime) {
        const blob = new Blob([content], { type: mime + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    }

    function openExportDialog() {
        if (!state.session) return;
        if (!state.path.length) { toast('这个对话还没有内容', 'error'); return; }
        els.exportDialog.hidden = false;
    }

    function exportHeader() {
        const session = state.session;
        const ai = session.aiCard || {};
        const me = session.userCard || {};
        const preset = activePreset();
        const lines = [];
        lines.push('标题：' + (session.title || '未命名'));
        if (ai.name) lines.push('AI 角色：' + ai.name);
        if (me.name) lines.push('我的角色：' + me.name);
        if (preset) lines.push('写作预设：' + preset.name);
        lines.push('导出时间：' + new Date().toLocaleString());
        return lines.join('\n') + '\n\n---\n\n';
    }

    function exportConversation(format) {
        const session = state.session;
        if (!session || !state.path.length) return;
        const aiName = (session.aiCard && session.aiCard.name) || 'AI';
        const meName = (session.userCard && session.userCard.name) || '我';
        const safeTitle = String(session.title || '对话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
        const stamp = new Date().toISOString().slice(0, 10);

        if (format === 'json') {
            const payload = {
                app: 'tinglan2',
                type: 'conversation',
                exportedAt: new Date().toISOString(),
                session: session,
                messages: state.messages
            };
            downloadFile(safeTitle + '_' + stamp + '.json', JSON.stringify(payload, null, 2), 'application/json');
        } else if (format === 'md') {
            const body = state.path.map(function (node) {
                return '**' + (node.role === 'user' ? meName : aiName) + '**：\n\n' + (node.content || '');
            }).join('\n\n');
            downloadFile(safeTitle + '_' + stamp + '.md', exportHeader() + body, 'text/markdown');
        } else {
            const body = state.path.map(function (node) {
                return (node.role === 'user' ? meName : aiName) + '：\n' + (node.content || '');
            }).join('\n\n');
            downloadFile(safeTitle + '_' + stamp + '.txt', exportHeader() + body, 'text/plain');
        }
        els.exportDialog.hidden = true;
        toast('已导出');
    }

    // ==================== 备份 / 恢复 ====================

    async function backupAllData() {
        try {
            const sessions = await Store.listSessions();
            const messages = await Store.getAllMessages();
            const cards = await Store.listCards();
            const payload = {
                app: 'tinglan2',
                type: 'backup',
                version: 2,
                exportedAt: new Date().toISOString(),
                sessions: sessions,
                messages: messages,
                cards: cards,
                settings: {
                    presets: state.settings.presets,
                    activePresetId: state.settings.activePresetId,
                    behavior: state.settings.behavior,
                    theme: document.body.dataset.theme
                }
            };
            const stamp = new Date().toISOString().slice(0, 10);
            downloadFile('听澜2备份_' + stamp + '.json', JSON.stringify(payload), 'application/json');
            els.settingsDialog.hidden = true;
            toast('备份已下载（不含背景图）');
        } catch (err) {
            toast('备份失败：' + err.message, 'error');
        }
    }

    function restoreBackup() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = function () {
            const file = input.files && input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async function () {
                let data = null;
                try { data = JSON.parse(reader.result); } catch (err) { data = null; }
                if (!data || !Array.isArray(data.sessions)) {
                    toast('这不是听澜的备份文件', 'error');
                    return;
                }
                if (!window.confirm('恢复会覆盖当前所有对话、角色和设置，确定继续吗？')) return;
                try {
                    await Store.importAll({
                        sessions: data.sessions,
                        messages: Array.isArray(data.messages) ? data.messages : [],
                        cards: Array.isArray(data.cards) ? data.cards : []
                    });
                    if (data.settings) {
                        if (Array.isArray(data.settings.presets) && data.settings.presets.length) {
                            localStorage.setItem(LS_PRESETS, JSON.stringify(data.settings.presets));
                            localStorage.setItem(LS_ACTIVE_PRESET, data.settings.activePresetId || '');
                        }
                        if (typeof data.settings.behavior === 'string') {
                            localStorage.setItem(LS_BEHAVIOR, data.settings.behavior);
                        }
                        if (data.settings.theme) {
                            localStorage.setItem(LS_THEME, data.settings.theme);
                        }
                    }
                    toast('恢复完成，正在重新载入…');
                    setTimeout(function () { location.reload(); }, 700);
                } catch (err) {
                    toast('恢复失败：' + err.message, 'error');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    // ==================== 修改我的消息 ====================

    function openEditMessage(node) {
        if (state.streaming) { toast('正在生成，稍等', 'error'); return; }
        state.editingNodeId = node.id;
        els.editMsgText.value = node.content || '';
        els.editMsgDialog.hidden = false;
        setTimeout(function () { els.editMsgText.focus(); }, 30);
    }

    function saveEditedMessage() {
        const text = els.editMsgText.value.trim();
        if (!text || !state.session) return;
        const old = state.messages.find(function (item) { return item.id === state.editingNodeId; });
        if (!old) { els.editMsgDialog.hidden = true; return; }

        const node = {
            id: newId(),
            sessionId: state.session.id,
            parentId: old.parentId,
            role: 'user',
            content: text,
            createdAt: Date.now()
        };
        state.messages.push(node);
        state.leafId = node.id;
        state.path = buildPath(state.messages, node.id);
        state.session.leafId = node.id;
        state.autoPushCount = 0;
        state.lastActivity = Date.now();
        persistSession(state.session, false);
        Store.putMessage(node).catch(function (err) { toast('保存失败：' + err.message, 'error'); });
        els.editMsgDialog.hidden = true;
        renderPath();
        updateHeader();
        generateReply(state.session, node.id, state.path);
    }

    // ==================== 侧栏 ====================

    function openSidebar() {
        els.sidebar.classList.add('open');
        els.scrim.classList.add('show');
    }

    function closeSidebar() {
        els.sidebar.classList.remove('open');
        els.scrim.classList.remove('show');
    }

    function sortedSessions() {
        return state.sessions.slice().sort(function (a, b) {
            if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
            return (b.updatedAt || 0) - (a.updatedAt || 0);
        });
    }

    function togglePin(session) {
        session.pinned = !session.pinned;
        persistSession(session, false);
        renderSessionList();
    }

    function renderSessionList() {
        els.chatList.innerHTML = '';
        const query = state.search.trim().toLowerCase();
        let list = sortedSessions();
        if (query) {
            list = list.filter(function (session) {
                const title = (session.title || '').toLowerCase();
                return title.indexOf(query) >= 0 || state.searchMatches.has(session.id);
            });
        }
        if (!list.length) {
            els.chatList.appendChild(h('p', 'side-note', query ? '没有匹配的对话' : '还没有对话'));
            return;
        }

        list.forEach(function (session) {
            const item = h('div', 'chat-item' + (state.session && state.session.id === session.id ? ' active' : ''));
            item.title = session.title || '新对话';
            item.addEventListener('click', function () { switchSession(session.id); });

            const main = h('div', 'chat-main');
            main.appendChild(h('span', 'title', session.title || '新对话'));
            if (query && state.searchMatches.has(session.id)) {
                main.appendChild(h('span', 'chat-snippet', state.searchMatches.get(session.id)));
            }
            item.appendChild(main);

            const pin = h('button', 'pin' + (session.pinned ? ' on' : ''), '📌');
            pin.type = 'button';
            pin.title = session.pinned ? '取消置顶' : '置顶';
            pin.addEventListener('click', function (event) {
                event.stopPropagation();
                togglePin(session);
            });
            item.appendChild(pin);

            const del = h('button', 'del', '×');
            del.type = 'button';
            del.title = '删除对话';
            del.addEventListener('click', function (event) {
                event.stopPropagation();
                removeSession(session.id);
            });
            item.appendChild(del);
            els.chatList.appendChild(item);
        });
    }

    let searchTimer = null;

    function onSearchInput() {
        state.search = els.searchInput.value;
        state.searchMatches.clear();
        renderSessionList();
        if (searchTimer) clearTimeout(searchTimer);
        const query = state.search.trim();
        if (!query) return;
        searchTimer = setTimeout(function () { runContentSearch(query); }, 220);
    }

    async function runContentSearch(query) {
        try {
            const hits = await Store.searchMessages(query);
            if (state.search.trim() !== query) return;
            const matches = new Map();
            hits.forEach(function (hit) {
                if (!matches.has(hit.sessionId)) matches.set(hit.sessionId, hit.snippet);
            });
            state.searchMatches = matches;
            renderSessionList();
        } catch (err) { /* 搜索失败不打扰使用 */ }
    }

    // ==================== 会话 ====================

    async function loadSessions() {
        try {
            state.sessions = await Store.listSessions();
        } catch (err) {
            state.sessions = [];
            toast('读取本地数据失败：' + err.message, 'error');
        }
    }

    async function createSession() {
        if (state.streaming) { state.suppressAbortToast = true; stopStreaming(); }
        const now = Date.now();
        const session = {
            id: newId(),
            title: '新对话',
            createdAt: now,
            updatedAt: now,
            leafId: null,
            deepThink: false
        };
        state.sessions = [session].concat(state.sessions);
        renderSessionList();
        await openSession(session.id);
        try { await Store.putSession(session); } catch (err) { toast('保存对话失败：' + err.message, 'error'); }
    }

    /** 点「+」：当前就是空对话时，不重复建，直接回到输入框 */
    function newChat() {
        closeSidebar();
        if (state.session && state.path.length === 0) {
            els.input.focus();
            return;
        }
        createSession();
    }

    async function switchSession(id) {        if (state.session && state.session.id === id) { closeSidebar(); return; }
        if (state.streaming) { state.suppressAbortToast = true; stopStreaming(); }
        await openSession(id);
    }

    async function openSession(id) {
        let session = state.sessions.find(function (s) { return s.id === id; });
        if (!session) {
            try { session = await Store.getSession(id); } catch (err) { session = null; }
        }
        if (!session) { toast('这个对话已经不存在了', 'error'); return; }

        state.session = session;
        try {
            state.messages = await Store.listMessages(id);
        } catch (err) {
            state.messages = [];
            toast('读取消息失败：' + err.message, 'error');
        }
        state.path = buildPath(state.messages, session.leafId);
        state.leafId = state.path.length ? state.path[state.path.length - 1].id : null;
        state.autoPushCount = 0;
        state.lastActivity = Date.now();
        if (state.leafId !== session.leafId) {
            session.leafId = state.leafId;
            persistSession(session, false);
        }
        updateThinkUI();
        updateHeader();
        renderPath();
        renderSessionList();
        closeSidebar();
    }

    async function removeSession(id) {
        const session = state.sessions.find(function (s) { return s.id === id; });
        if (!session) return;
        if (!window.confirm('删除对话「' + (session.title || '新对话') + '」？\n里面的消息也会一起删掉，无法恢复。')) return;
        if (state.streaming && state.session && state.session.id === id) {
            state.suppressAbortToast = true;
            stopStreaming();
        }
        try {
            await Store.deleteSession(id);
        } catch (err) {
            toast('删除失败：' + err.message, 'error');
            return;
        }
        state.sessions = state.sessions.filter(function (s) { return s.id !== id; });
        if (state.session && state.session.id === id) {
            state.session = null;
            if (state.sessions.length) await openSession(state.sessions[0].id);
            else await createSession();
        } else {
            renderSessionList();
        }
        toast('对话已删除');
    }

    async function persistSession(session, bump) {
        if (bump !== false) session.updatedAt = Date.now();
        try { await Store.putSession(session); } catch (err) { toast('保存失败：' + err.message, 'error'); }
    }

    function renameCurrentSession() {
        if (!state.session) return;
        els.renameInput.value = state.session.title || '';
        els.renameDialog.hidden = false;
        setTimeout(function () { els.renameInput.focus(); els.renameInput.select(); }, 30);
    }

    function saveRename() {
        const title = els.renameInput.value.trim();
        if (!title || !state.session) { els.renameDialog.hidden = true; return; }
        state.session.title = title;
        els.renameDialog.hidden = true;
        updateHeader();
        renderSessionList();
        persistSession(state.session);
    }

    // ==================== 路径与渲染 ====================

    /** 从叶节点沿 parentId 回溯，得到当前这条时间线 */
    function buildPath(nodes, leafId) {
        const byId = new Map();
        nodes.forEach(function (n) { byId.set(n.id, n); });
        let cursor = leafId ? byId.get(leafId) : null;
        if (!cursor && nodes.length) cursor = nodes[nodes.length - 1];
        const path = [];
        let guard = 0;
        while (cursor && guard < 10000) {
            path.push(cursor);
            cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
            guard++;
        }
        return path.reverse();
    }

    function emptyState() {
        const box = h('div', 'empty');
        const icon = h('div', 'big', '🪶');
        const title = h('div', '', '开始一段新对话');
        const hint = h('div', 'hint', '设好 API Key 后直接说点什么。\n对话会自动存在这台设备上。');
        box.appendChild(icon);
        box.appendChild(title);
        box.appendChild(hint);
        return box;
    }

    function buildThink(reasoning, seconds, open) {
        const think = h('div', 'think' + (open ? ' open' : ''));
        const head = h('button', 'think-head');
        head.type = 'button';
        const caret = h('span', 'caret', '▸');
        const label = h('span', '', '已深度思考' + (seconds ? ' · 用时 ' + seconds + ' 秒' : ''));
        head.appendChild(caret);
        head.appendChild(label);
        const body = h('div', 'think-body');
        body.textContent = reasoning || '';
        if (!open) body.hidden = true;
        head.addEventListener('click', function () {
            const willOpen = body.hidden;
            body.hidden = !willOpen;
            think.classList.toggle('open', willOpen);
        });
        think.appendChild(head);
        think.appendChild(body);
        return think;
    }

    function buildMessageEl(node) {
        const wrap = h('div', 'msg ' + node.role);
        const bubble = h('div', 'bubble');
        if (node.reasoning) {
            bubble.appendChild(buildThink(node.reasoning, node.thinkSecs, false));
        }
        const content = h('div', 'content');
        content.innerHTML = renderMarkdown(node.content || '');
        if (node.autoPush) bubble.appendChild(h('div', 'auto-tag', '❤️ 主动'));
        bubble.appendChild(content);
        wrap.appendChild(bubble);

        const tools = buildTools(node);
        if (tools.children.length) wrap.appendChild(tools);
        return wrap;
    }

    function buildTools(node) {
        const tools = h('div', 'msg-tools');
        const siblings = siblingsOf(node);
        if (siblings.length > 1) {
            tools.classList.add('show');
            tools.appendChild(buildVersionControl(node, siblings));
        }
        if (node.role === 'assistant') {
            const copy = h('button', 'tool-btn', '复制');
            copy.type = 'button';
            copy.addEventListener('click', function () { copyText(node.content || ''); });

            const regen = h('button', 'tool-btn', '重抽');
            regen.type = 'button';
            regen.title = '再生成一个版本，旧版本会保留';
            regen.addEventListener('click', function () { regenerate(node); });

            const cont = h('button', 'tool-btn', '从这里继续');
            cont.type = 'button';
            cont.title = '回到这个时间点，之后发的消息会开一条新分支';
            cont.addEventListener('click', function () { continueFrom(node); });

            tools.appendChild(copy);
            tools.appendChild(regen);
            tools.appendChild(cont);
            if (node.stopped) tools.appendChild(h('span', 'tool-btn', '已停止'));
        } else {
            const edit = h('button', 'tool-btn', '改这句');
            edit.type = 'button';
            edit.title = '修改后作为新分支，原消息保留';
            edit.addEventListener('click', function () { openEditMessage(node); });
            tools.appendChild(edit);
        }
        return tools;
    }

    // ==================== 分支：版本切换与分叉 ====================

    function childrenOf(parentId) {
        const key = parentId || null;
        return state.messages
            .filter(function (node) { return (node.parentId || null) === key; })
            .sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    }

    function siblingsOf(node) {
        return childrenOf(node.parentId);
    }

    /** 一条分支上最后一条消息（同类里取最新的孩子一直往下走） */
    function deepestLeaf(node) {
        let current = node;
        for (let guard = 0; guard < 500; guard++) {
            const kids = childrenOf(current.id);
            if (!kids.length) break;
            current = kids[kids.length - 1];
        }
        return current;
    }

    function switchSibling(node, direction) {
        if (state.streaming) { toast('正在生成，稍后再切换', 'error'); return; }
        if (!state.session) return;
        const siblings = siblingsOf(node);
        const index = siblings.findIndex(function (item) { return item.id === node.id; });
        const target = siblings[index + direction];
        if (!target) return;

        const leaf = deepestLeaf(target);
        state.leafId = leaf.id;
        state.path = buildPath(state.messages, leaf.id);
        state.session.leafId = leaf.id;
        persistSession(state.session, false);
        renderPath();
        updateHeader();
    }

    function regenerate(node) {
        if (state.streaming) { toast('正在生成，稍等', 'error'); return; }
        if (!state.session) return;
        const index = state.path.findIndex(function (item) { return item.id === node.id; });
        if (index <= 0) return;

        const basePath = state.path.slice(0, index);
        state.path = basePath;
        state.leafId = node.parentId || null;
        state.session.leafId = state.leafId;
        persistSession(state.session, false);
        renderPath();
        updateHeader();
        generateReply(state.session, node.parentId, basePath);
    }

    function continueFrom(node) {
        if (state.streaming) { toast('正在生成，稍等', 'error'); return; }
        if (!state.session) return;
        state.leafId = node.id;
        state.path = buildPath(state.messages, node.id);
        state.session.leafId = node.id;
        persistSession(state.session, false);
        renderPath();
        updateHeader();
        els.input.focus();
        toast('从这里继续：下一条消息会开一条新分支');
    }

    function newestMessage() {
        let newest = null;
        state.messages.forEach(function (node) {
            if (!newest || (node.createdAt || 0) >= (newest.createdAt || 0)) newest = node;
        });
        return newest;
    }

    /** 正在看旧分支时，顶栏出现「↩ 最新」 */
    function updateLatestButton() {
        if (!els.latestBtn) return;
        const newest = newestMessage();
        els.latestBtn.hidden = !(newest && state.leafId && newest.id !== state.leafId);
    }

    function jumpToLatest() {
        if (state.streaming) { toast('正在生成，稍等', 'error'); return; }
        if (!state.session) return;
        const newest = newestMessage();
        if (!newest) return;
        state.leafId = newest.id;
        state.path = buildPath(state.messages, newest.id);
        state.session.leafId = newest.id;
        persistSession(state.session, false);
        renderPath();
        updateHeader();
    }

    function buildVersionControl(node, siblings) {        const index = siblings.findIndex(function (item) { return item.id === node.id; });
        const box = h('span', 'version-ctl');

        const prev = h('button', 'ver-btn', '‹');
        prev.type = 'button';
        prev.title = '上一个版本';
        prev.disabled = index <= 0;
        prev.addEventListener('click', function () { switchSibling(node, -1); });

        const next = h('button', 'ver-btn', '›');
        next.type = 'button';
        next.title = '下一个版本';
        next.disabled = index >= siblings.length - 1;
        next.addEventListener('click', function () { switchSibling(node, 1); });

        box.appendChild(prev);
        box.appendChild(h('span', 'ver-label', (index + 1) + '/' + siblings.length));
        box.appendChild(next);
        return box;
    }

    function removeEmptyState() {
        const empty = els.messages.querySelector('.empty');
        if (empty) empty.remove();
    }

    function renderPath() {
        clearErrorRow();
        els.messages.innerHTML = '';
        if (!state.path.length) {
            els.messages.appendChild(emptyState());
        } else {
            state.path.forEach(function (node) {
                els.messages.appendChild(buildMessageEl(node));
            });
        }
        els.jump.hidden = true;
        scrollToBottom();
    }

    // ==================== 滚动 ====================

    function nearBottom() {
        const box = els.messages;
        return box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    }

    function scrollToBottom() {
        els.messages.scrollTop = els.messages.scrollHeight;
        els.jump.hidden = true;
    }

    // ==================== 请求 ====================

    /** 上下文保护：超长时从最老的整轮开始丢，避免一键 400 */
    function buildApiMessages(path, systemPrompt) {
        const body = path.map(function (node) { return { role: node.role, content: node.content || '' }; });
        while (body.length && body[0].role !== 'user') body.shift();
        let chars = body.reduce(function (sum, m) { return sum + m.content.length; }, 0);
        let trimmed = 0;
        while (chars > CTX_CHAR_LIMIT && body.length > 6) {
            chars -= body[0].content.length;
            body.shift();
            trimmed++;
            while (body.length && body[0].role !== 'user') {
                chars -= body[0].content.length;
                body.shift();
                trimmed++;
            }
        }
        const messages = systemPrompt ? [{ role: 'system', content: systemPrompt }].concat(body) : body;
        return { messages: messages, trimmed: trimmed };
    }

    function updateHeader() {
        if (!state.session) { els.title.textContent = '新对话'; els.ctxNote.textContent = ''; return; }
        els.title.textContent = state.session.title || '新对话';
        const result = buildApiMessages(state.path);
        const bits = [];
        const aiName = state.session.aiCard && state.session.aiCard.name;
        if (aiName && state.session.title !== aiName) bits.push('🎭 ' + aiName);
        const preset = activePreset();
        if (preset && preset.name) bits.push('📋 ' + preset.name);
        if (result.trimmed) bits.push('已省略较早的 ' + result.trimmed + ' 条');
        els.ctxNote.textContent = bits.join(' · ');
        updateLatestButton();
    }

    function createLiveBubble() {
        const wrap = h('div', 'msg assistant');
        const bubble = h('div', 'bubble');

        const think = h('div', 'think open');
        think.hidden = true;
        const head = h('button', 'think-head');
        head.type = 'button';
        const caret = h('span', 'caret', '▸');
        const label = h('span', '', '正在深度思考…');
        head.appendChild(caret);
        head.appendChild(label);
        const thinkBody = h('div', 'think-body');
        think.appendChild(head);
        think.appendChild(thinkBody);

        const content = h('div', 'content');
        const contentNode = document.createTextNode('思考中…');
        content.appendChild(contentNode);

        bubble.appendChild(think);
        bubble.appendChild(content);
        wrap.appendChild(bubble);
        els.messages.appendChild(wrap);
        scrollToBottom();

        let reasoningLength = 0;
        let contentLength = 0;
        let contentStarted = false;
        let reasoningText = '';
        let contentText = '';

        head.addEventListener('click', function () {
            thinkBody.hidden = !thinkBody.hidden;
            think.classList.toggle('open', !thinkBody.hidden);
        });

        return {
            setReasoning: function (text) {
                reasoningText = text;
                if (think.hidden) { think.hidden = false; thinkBody.textContent = ''; reasoningLength = 0; }
                const stick = nearBottom();
                thinkBody.appendChild(document.createTextNode(text.slice(reasoningLength)));
                reasoningLength = text.length;
                if (stick) scrollToBottom();
            },
            setContent: function (text) {
                contentText = text;
                const stick = nearBottom();
                if (!contentStarted) {
                    contentStarted = true;
                    contentNode.data = '';
                    thinkBody.hidden = true;
                    think.classList.remove('open');
                    label.textContent = '已深度思考';
                }
                contentNode.appendData(text.slice(contentLength));
                contentLength = text.length;
                if (stick) scrollToBottom();
            },
            getContent: function () { return contentText; },
            getReasoning: function () { return reasoningText; },
            remove: function () { wrap.remove(); }
        };
    }

    async function send() {
        if (state.streaming) return;
        const text = els.input.value.trim();
        if (!text) return;
        if (!getKey()) { openKeyDialog(); return; }
        if (!state.session) await createSession();
        clearErrorRow();

        const session = state.session;
        const node = {
            id: newId(),
            sessionId: session.id,
            parentId: state.leafId,
            role: 'user',
            content: text,
            createdAt: Date.now()
        };

        els.input.value = '';
        autoGrowInput();

        state.messages.push(node);
        state.path.push(node);
        state.leafId = node.id;
        session.leafId = node.id;
        state.autoPushCount = 0;
        state.lastActivity = Date.now();

        if (!session.title || session.title === '新对话') {
            session.title = makeTitle(text);
        }
        removeEmptyState();
        els.messages.appendChild(buildMessageEl(node));
        scrollToBottom();
        updateHeader();
        renderSessionList();
        persistSession(session);

        Store.putMessage(node).catch(function (err) { toast('保存消息失败：' + err.message, 'error'); });

        await generateReply(session, node.id);
    }

    async function generateReply(session, parentId, basePath, opts) {
        if (state.streaming) return;
        opts = opts || {};
        state.streaming = true;
        setBusy(true);
        state.suppressAbortToast = false;
        const controller = new AbortController();
        state.controller = controller;
        const startedAt = Date.now();
        const live = createLiveBubble();
        const systemPrompt = opts.systemPrompt || currentSystemPrompt();
        const contextPath = basePath || state.path;
        const built = buildApiMessages(contextPath, systemPrompt);
        const onSameSession = function () { return state.session && state.session.id === session.id; };

        try {
            const result = await API.stream({
                apiKey: getKey(),
                model: session.deepThink ? API.MODELS.think : API.MODELS.chat,
                messages: built.messages,
                signal: controller.signal,
                onReasoning: live.setReasoning,
                onContent: live.setContent
            });
            live.remove();

            const node = {
                id: newId(),
                sessionId: session.id,
                parentId: parentId,
                role: 'assistant',
                content: result.content || '',
                createdAt: Date.now()
            };
            if (result.reasoning) {
                node.reasoning = result.reasoning;
                node.thinkSecs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
            }
            if (opts.auto) node.autoPush = true;

            session.leafId = node.id;
            persistSession(session);
            Store.putMessage(node).catch(function (err) { toast('保存回复失败：' + err.message, 'error'); });

            if (onSameSession()) {
                state.messages.push(node);
                state.leafId = node.id;
                state.path = buildPath(state.messages, node.id);
                renderPath();
                updateHeader();
            }

            if (opts.auto) {
                state.autoPushCount += 1;
                state.lastActivity = Date.now();
            }
        } catch (err) {
            live.remove();
            if (err && err.name === 'AbortError') {
                const partial = live.getContent();
                const partialReasoning = live.getReasoning();
                if (partial && partial.trim()) {
                    const node = {
                        id: newId(),
                        sessionId: session.id,
                        parentId: parentId,
                        role: 'assistant',
                        content: partial,
                        createdAt: Date.now(),
                        stopped: true
                    };
                    if (partialReasoning) node.reasoning = partialReasoning;
                    session.leafId = node.id;
                    persistSession(session);
                    Store.putMessage(node).catch(function () {});
                    if (onSameSession()) {
                        state.messages.push(node);
                        state.leafId = node.id;
                        state.path = buildPath(state.messages, node.id);
                        renderPath();
                        updateHeader();
                    }
                }
                if (!state.suppressAbortToast) toast('已停止生成');
            } else {
                const message = (err && err.message) ? err.message : '发送失败，请重试。';
                if (onSameSession()) showErrorRow(session, parentId, message);
                else toast(message, 'error');
            }
        } finally {
            state.streaming = false;
            state.controller = null;
            state.suppressAbortToast = false;
            setBusy(false);
        }
    }

    function stopStreaming() {
        if (state.controller) state.controller.abort();
    }

    let errorRow = null;

    function showErrorRow(session, parentId, message) {
        clearErrorRow();
        const row = h('div', 'error-row');
        const text = h('div', 'grow', message);
        const retry = h('button', 'tool-btn', '重试');
        retry.type = 'button';
        retry.addEventListener('click', function () {
            row.remove();
            if (errorRow === row) errorRow = null;
            generateReply(session, parentId);
        });
        row.appendChild(text);
        row.appendChild(retry);
        els.messages.appendChild(row);
        errorRow = row;
        scrollToBottom();
    }

    function clearErrorRow() {
        if (errorRow) {
            errorRow.remove();
            errorRow = null;
        }
    }

    function setBusy(busy) {
        els.send.hidden = busy;
        els.stop.hidden = !busy;
        els.input.disabled = false;
    }

    function makeTitle(text) {
        const line = String(text).replace(/\s+/g, ' ').trim();
        return line.length > 24 ? line.slice(0, 24) + '…' : (line || '新对话');
    }

    // ==================== 深度思考 ====================

    function updateThinkUI() {
        const on = !!(state.session && state.session.deepThink);
        els.think.setAttribute('aria-pressed', on ? 'true' : 'false');
        els.think.title = on ? '深度思考已开启：先展示推理过程，再回答' : '深度思考已关闭：直接回答';
    }

    function toggleThink() {
        if (!state.session || state.streaming) return;
        state.session.deepThink = !state.session.deepThink;
        updateThinkUI();
        persistSession(state.session);
        toast(state.session.deepThink ? '深度思考已开启' : '深度思考已关闭');
    }

    // ==================== 复制 ====================

    function copyText(text) {
        if (!text) return;
        const done = function () { toast('已复制'); };
        const fail = function () { toast('复制失败，请手动选中', 'error'); };
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(done).catch(fail);
        } else {
            try {
                const area = document.createElement('textarea');
                area.value = text;
                area.style.position = 'fixed';
                area.style.opacity = '0';
                document.body.appendChild(area);
                area.select();
                document.execCommand('copy');
                area.remove();
                done();
            } catch (err) { fail(); }
        }
    }

    // ==================== 输入框 ====================

    function autoGrowInput() {
        els.input.style.height = 'auto';
        els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
    }

    // ==================== 事件 ====================

    function bindEvents() {
        $('newChatBtn').addEventListener('click', newChat);
        $('menuBtn').addEventListener('click', openSidebar);
        $('closeSidebarBtn').addEventListener('click', closeSidebar);
        els.scrim.addEventListener('click', closeSidebar);
        $('renameBtn').addEventListener('click', renameCurrentSession);
        $('latestBtn').addEventListener('click', jumpToLatest);
        els.searchInput.addEventListener('input', onSearchInput);

        // 设置
        $('settingsBtn').addEventListener('click', openSettings);
        els.settingsClose.addEventListener('click', function () { els.settingsDialog.hidden = true; });
        $('openBg').addEventListener('click', function () { els.settingsDialog.hidden = true; openBgDialog(); });
        $('openAutoPush').addEventListener('click', function () { els.settingsDialog.hidden = true; openAutoPushDialog(); });
        $('openExport').addEventListener('click', function () { els.settingsDialog.hidden = true; openExportDialog(); });
        $('doBackup').addEventListener('click', backupAllData);
        $('doRestore').addEventListener('click', restoreBackup);
        $('openTheme').addEventListener('click', function () { toggleTheme(); refreshSettingsHints(); });
        $('openKey').addEventListener('click', function () { els.settingsDialog.hidden = true; openKeyDialog(); });

        // 背景
        $('bgClose').addEventListener('click', function () { els.bgDialog.hidden = true; });
        $('bgCancel').addEventListener('click', function () { els.bgDialog.hidden = true; });
        $('bgPick').addEventListener('click', function () { els.bgFile.click(); });
        els.bgFile.addEventListener('change', handleBgFile);
        els.bgOpacity.addEventListener('input', updateBgPreview);
        els.bgBlur.addEventListener('input', updateBgPreview);
        $('bgSave').addEventListener('click', saveBgDialog);
        $('bgRemove').addEventListener('click', removeBg);

        // 角色主动性
        $('apClose').addEventListener('click', function () { els.autoPushDialog.hidden = true; });
        $('apCancel').addEventListener('click', function () { els.autoPushDialog.hidden = true; });
        $('apSave').addEventListener('click', saveAutoPushDialog);
        els.apInterval.addEventListener('input', function () {
            els.apIntervalVal.textContent = els.apInterval.value + ' 分钟';
        });
        els.apMax.addEventListener('input', function () {
            els.apMaxVal.textContent = '最多 ' + els.apMax.value + ' 句';
        });

        // 导出
        $('expTxt').addEventListener('click', function () { exportConversation('txt'); });
        $('expMd').addEventListener('click', function () { exportConversation('md'); });
        $('expJson').addEventListener('click', function () { exportConversation('json'); });
        $('exportCancel').addEventListener('click', function () { els.exportDialog.hidden = true; });

        // 修改我的消息
        $('editMsgClose').addEventListener('click', function () { els.editMsgDialog.hidden = true; });
        $('editMsgCancel').addEventListener('click', function () { els.editMsgDialog.hidden = true; });
        $('editMsgSave').addEventListener('click', saveEditedMessage);

        els.think.addEventListener('click', toggleThink);

        // 角色 / 背景 / 预设 / 行为准则 / 模板
        $('roleBtn').addEventListener('click', function () { openCardDialog(state.cardTab); });
        $('cardClose').addEventListener('click', function () { els.cardDialog.hidden = true; });
        $('cardSave').addEventListener('click', saveCardDialog);
        $('cardClear').addEventListener('click', clearCardPage);
        $('cardTemplates').addEventListener('click', function () {
            openTemplates(state.cardTab === 'scene' ? null : state.cardTab);
        });
        els.cardTabs.addEventListener('click', function (event) {
            Array.prototype.forEach.call(els.cardTabs.children, function (button) {
                if (button === event.target) setCardTab(button.dataset.tab);
            });
        });

        $('presetBtn').addEventListener('click', openPresetDialog);
        els.presetSelect.addEventListener('change', onPresetChange);
        $('presetNew').addEventListener('click', newPreset);
        $('presetRename').addEventListener('click', renamePreset);
        $('presetDel').addEventListener('click', deletePreset);
        $('presetSave').addEventListener('click', savePresetDialog);
        $('presetCancel').addEventListener('click', function () { els.presetDialog.hidden = true; });
        $('presetClose').addEventListener('click', function () { els.presetDialog.hidden = true; });

        $('behaviorBtn').addEventListener('click', openBehaviorDialog);
        $('behaviorSave').addEventListener('click', saveBehaviorDialog);
        $('behaviorCancel').addEventListener('click', function () { els.behaviorDialog.hidden = true; });
        $('behaviorClose').addEventListener('click', function () { els.behaviorDialog.hidden = true; });
        $('behaviorReset').addEventListener('click', resetBehavior);

        $('templateBtn').addEventListener('click', function () { openTemplates(null); });
        $('templateClose').addEventListener('click', function () { els.templateDialog.hidden = true; });

        els.send.addEventListener('click', send);
        els.stop.addEventListener('click', stopStreaming);

        els.keySave.addEventListener('click', saveKey);
        els.keyCancel.addEventListener('click', closeKeyDialog);
        els.keyInput.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' && !event.isComposing) saveKey();
        });

        els.renameSave.addEventListener('click', saveRename);
        els.renameCancel.addEventListener('click', function () { els.renameDialog.hidden = true; });
        els.renameInput.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' && !event.isComposing) saveRename();
        });

        [
            els.keyDialog, els.renameDialog, els.cardDialog, els.presetDialog,
            els.behaviorDialog, els.templateDialog, els.settingsDialog, els.bgDialog,
            els.autoPushDialog, els.exportDialog, els.editMsgDialog
        ].forEach(function (dialog) {
            dialog.addEventListener('click', function (event) {
                if (event.target === dialog) dialog.hidden = true;
            });
        });

        els.input.addEventListener('input', autoGrowInput);
        els.input.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter') return;
            if (event.isComposing || event.keyCode === 229) return;
            if (isCoarsePointer() && !event.ctrlKey && !event.metaKey) return;
            if (event.shiftKey) return;
            event.preventDefault();
            send();
        });

        els.messages.addEventListener('scroll', function () {
            els.jump.hidden = nearBottom();
        });
        els.jump.addEventListener('click', scrollToBottom);

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                closeSidebar();
                els.keyDialog.hidden = true;
                els.renameDialog.hidden = true;
                els.cardDialog.hidden = true;
                els.presetDialog.hidden = true;
                els.behaviorDialog.hidden = true;
                els.templateDialog.hidden = true;
                els.settingsDialog.hidden = true;
                els.bgDialog.hidden = true;
                els.autoPushDialog.hidden = true;
                els.exportDialog.hidden = true;
                els.editMsgDialog.hidden = true;
            }
        });

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', function () {
                if (nearBottom()) scrollToBottom();
            });
        }
    }

    // ==================== 启动 ====================

    async function init() {
        els.sidebar = $('sidebar');
        els.scrim = $('scrim');
        els.chatList = $('chatList');
        els.title = $('chatTitle');
        els.ctxNote = $('ctxNote');
        els.latestBtn = $('latestBtn');
        els.messages = $('messages');
        els.input = $('input');
        els.send = $('sendBtn');
        els.stop = $('stopBtn');
        els.think = $('thinkBtn');
        els.jump = $('jumpBtn');
        els.toast = $('toast');
        els.keyDialog = $('keyDialog');
        els.keyInput = $('keyInput');
        els.keySave = $('keySave');
        els.keyCancel = $('keyCancel');
        els.renameDialog = $('renameDialog');
        els.renameInput = $('renameInput');
        els.renameSave = $('renameSave');
        els.renameCancel = $('renameCancel');
        els.cardDialog = $('cardDialog');
        els.cardTabs = $('cardTabs');
        els.presetDialog = $('presetDialog');
        els.presetSelect = $('presetSelect');
        els.behaviorDialog = $('behaviorDialog');
        els.behaviorText = $('behaviorText');
        els.templateDialog = $('templateDialog');
        els.templateList = $('templateList');
        els.searchInput = $('searchInput');
        els.settingsDialog = $('settingsDialog');
        els.settingsClose = $('settingsClose');
        els.bgState = $('bgState');
        els.apState = $('apState');
        els.themeState = $('themeState');
        els.keyState = $('keyState');
        els.bgDialog = $('bgDialog');
        els.bgPreview = $('bgPreview');
        els.bgPreviewImg = $('bgPreviewImg');
        els.bgPreviewText = $('bgPreviewText');
        els.bgFile = $('bgFile');
        els.bgPick = $('bgPick');
        els.bgOpacity = $('bgOpacity');
        els.bgOpacityVal = $('bgOpacityVal');
        els.bgBlur = $('bgBlur');
        els.bgBlurVal = $('bgBlurVal');
        els.bgLayer = $('chatBgLayer');
        els.autoPushDialog = $('autoPushDialog');
        els.apEnabled = $('apEnabled');
        els.apInterval = $('apInterval');
        els.apIntervalVal = $('apIntervalVal');
        els.apMax = $('apMax');
        els.apMaxVal = $('apMaxVal');
        els.apPauseStart = $('apPauseStart');
        els.apPauseEnd = $('apPauseEnd');
        els.exportDialog = $('exportDialog');
        els.editMsgDialog = $('editMsgDialog');
        els.editMsgText = $('editMsgText');

        loadSettings();
        loadAutoPushSettings();
        buildCardForms();
        applyTheme();
        bindEvents();
        autoGrowInput();

        try {
            await Store.init();
        } catch (err) {
            toast('本地存储不可用：' + err.message, 'error');
        }
        await loadBackground();
        startAutoPushTimer();

        await loadSessions();
        renderSessionList();

        if (state.sessions.length) {
            const initial = sortedSessions()[0];
            await openSession(initial.id);
        } else {
            await createSession();
        }

        if (!getKey()) openKeyDialog();
        else if (!isCoarsePointer()) els.input.focus();
        registerServiceWorker();
    }

    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        if (location.protocol !== 'https:' && location.protocol !== 'http:') return;
        navigator.serviceWorker.register('./sw.js').catch(function () { /* 离线缓存失败不影响使用 */ });
    }

    // 调试/测试用的小接口（阶段 3 加分支时会用到）
    window.__tl2 = {
        state: state,
        send: send,
        createSession: createSession,
        openSession: openSession,
        removeSession: removeSession,
        buildApiMessages: buildApiMessages,
        buildPath: buildPath,
        renderMarkdown: renderMarkdown,
        generateReply: generateReply,
        settings: state.settings,
        activePreset: activePreset,
        currentSystemPrompt: currentSystemPrompt,
        openCardDialog: openCardDialog,
        saveCardDialog: saveCardDialog,
        openPresetDialog: openPresetDialog,
        savePresetDialog: savePresetDialog,
        openBehaviorDialog: openBehaviorDialog,
        saveBehaviorDialog: saveBehaviorDialog,
        openTemplates: openTemplates,
        saveTemplate: saveTemplate,
        listCards: function () { return Store.listCards(); },
        siblingsOf: siblingsOf,
        deepestLeaf: deepestLeaf,
        switchSibling: switchSibling,
        regenerate: regenerate,
        continueFrom: continueFrom,
        jumpToLatest: jumpToLatest,
        newestMessage: newestMessage,
        togglePin: togglePin,
        openEditMessage: openEditMessage,
        saveEditedMessage: saveEditedMessage,
        exportConversation: exportConversation,
        backupAllData: backupAllData,
        autoPushTick: autoPushTick,
        performAutoPush: performAutoPush,
        openAutoPushDialog: openAutoPushDialog,
        saveAutoPushDialog: saveAutoPushDialog,
        openBgDialog: openBgDialog,
        saveBgDialog: saveBgDialog,
        removeBg: removeBg,
        applyBackground: applyBackground,
        getBackground: function () { return Store.getSetting('background'); }
    };

    init();
})();
