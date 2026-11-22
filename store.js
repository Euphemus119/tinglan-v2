/* 听澜 2 · 数据层
   消息一律走 IndexedDB，不再用 localStorage 存对话：
   localStorage 只有 5MB，长对话 + 背景图很容易写满并静默丢数据。
*/
'use strict';

const Store = (function () {
    const DB_NAME = 'tinglan2';
    const DB_VERSION = 3;
    let dbPromise = null;

    function openDB() {
        return new Promise(function (resolve, reject) {
            if (!('indexedDB' in window)) {
                reject(new Error('这个浏览器不支持本地数据库（IndexedDB）'));
                return;
            }
            let req;
            try {
                req = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (err) {
                reject(err);
                return;
            }
            req.onupgradeneeded = function () {
                const db = req.result;
                if (!db.objectStoreNames.contains('sessions')) {
                    const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
                    sessions.createIndex('updatedAt', 'updatedAt');
                }
                if (!db.objectStoreNames.contains('messages')) {
                    const messages = db.createObjectStore('messages', { keyPath: 'id' });
                    messages.createIndex('sessionId', 'sessionId');
                    messages.createIndex('parentId', 'parentId');
                }
                if (!db.objectStoreNames.contains('cards')) {
                    const cards = db.createObjectStore('cards', { keyPath: 'id' });
                    cards.createIndex('kind', 'kind');
                }
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error || new Error('本地数据库打开失败')); };
            req.onblocked = function () { reject(new Error('数据库被其他标签页占用，请关掉多余的页面再试')); };
        });
    }

    function db() {
        if (!dbPromise) dbPromise = openDB();
        return dbPromise;
    }

    function toPromise(request) {
        return new Promise(function (resolve, reject) {
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error); };
        });
    }

    function txDone(tx) {
        return new Promise(function (resolve, reject) {
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error || new Error('写入失败')); };
            tx.onabort = function () { reject(tx.error || new Error('写入被中断')); };
        });
    }

    async function init() {
        await db();
    }

    async function listSessions() {
        const d = await db();
        const tx = d.transaction('sessions', 'readonly');
        const rows = await toPromise(tx.objectStore('sessions').getAll());
        return rows.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    }

    async function getSession(id) {
        const d = await db();
        const tx = d.transaction('sessions', 'readonly');
        return toPromise(tx.objectStore('sessions').get(id));
    }

    async function putSession(session) {
        const d = await db();
        const tx = d.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').put(session);
        await txDone(tx);
        return session;
    }

    /** 删除对话，连同它名下的所有消息一起删（避免遗留垃圾占空间） */
    async function deleteSession(id) {
        const d = await db();
        const tx = d.transaction(['sessions', 'messages'], 'readwrite');
        tx.objectStore('sessions').delete(id);
        const index = tx.objectStore('messages').index('sessionId');
        index.openCursor(IDBKeyRange.only(id)).onsuccess = function (event) {
            const cursor = event.target.result;
            if (!cursor) return;
            cursor.delete();
            cursor.continue();
        };
        await txDone(tx);
    }

    async function listMessages(sessionId) {
        const d = await db();
        const tx = d.transaction('messages', 'readonly');
        const rows = await toPromise(tx.objectStore('messages').index('sessionId').getAll(IDBKeyRange.only(sessionId)));
        return rows.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    }

    async function putMessage(message) {
        const d = await db();
        const tx = d.transaction('messages', 'readwrite');
        tx.objectStore('messages').put(message);
        await txDone(tx);
        return message;
    }

    async function deleteMessage(id) {
        const d = await db();
        const tx = d.transaction('messages', 'readwrite');
        tx.objectStore('messages').delete(id);
        await txDone(tx);
    }

    // ---------- 角色卡模板 ----------

    async function listCards(kind) {
        const d = await db();
        const tx = d.transaction('cards', 'readonly');
        const store = tx.objectStore('cards');
        const rows = kind
            ? await toPromise(store.index('kind').getAll(IDBKeyRange.only(kind)))
            : await toPromise(store.getAll());
        return rows.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    }

    async function putCard(card) {
        const d = await db();
        const tx = d.transaction('cards', 'readwrite');
        tx.objectStore('cards').put(card);
        await txDone(tx);
        return card;
    }

    async function deleteCard(id) {
        const d = await db();
        const tx = d.transaction('cards', 'readwrite');
        tx.objectStore('cards').delete(id);
        await txDone(tx);
    }

    // ---------- 设置（背景图等较大的数据） ----------

    async function getSetting(key) {
        const d = await db();
        const tx = d.transaction('settings', 'readonly');
        return toPromise(tx.objectStore('settings').get(key));
    }

    async function putSetting(value) {
        const d = await db();
        const tx = d.transaction('settings', 'readwrite');
        tx.objectStore('settings').put(value);
        await txDone(tx);
        return value;
    }

    async function deleteSetting(key) {
        const d = await db();
        const tx = d.transaction('settings', 'readwrite');
        tx.objectStore('settings').delete(key);
        await txDone(tx);
    }

    // ---------- 导出 / 备份 / 搜索 ----------

    async function getAllMessages() {
        const d = await db();
        const tx = d.transaction('messages', 'readonly');
        return toPromise(tx.objectStore('messages').getAll());
    }

    /** 全库搜索消息内容，返回 { sessionId, snippet }，最多 100 条命中 */
    async function searchMessages(query) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return [];
        const d = await db();
        return new Promise(function (resolve, reject) {
            const tx = d.transaction('messages', 'readonly');
            const request = tx.objectStore('messages').openCursor();
            const hits = [];
            request.onsuccess = function () {
                const cursor = request.result;
                if (!cursor || hits.length >= 100) { resolve(hits); return; }
                const message = cursor.value;
                const text = String(message.content || '');
                const index = text.toLowerCase().indexOf(q);
                if (index >= 0) {
                    const start = Math.max(0, index - 16);
                    hits.push({
                        sessionId: message.sessionId,
                        snippet: text.slice(start, index + q.length + 34).replace(/\s+/g, ' ')
                    });
                }
                cursor.continue();
            };
            request.onerror = function () { reject(request.error); };
        });
    }

    /** 恢复备份：清空三张表后整体写回（一个事务内完成） */
    async function importAll(payload) {
        const d = await db();
        const tx = d.transaction(['sessions', 'messages', 'cards'], 'readwrite');
        const sessions = tx.objectStore('sessions');
        const messages = tx.objectStore('messages');
        const cards = tx.objectStore('cards');
        sessions.clear();
        messages.clear();
        cards.clear();
        (payload.sessions || []).forEach(function (s) { sessions.put(s); });
        (payload.messages || []).forEach(function (m) { messages.put(m); });
        (payload.cards || []).forEach(function (c) { cards.put(c); });
        await txDone(tx);
    }

    return {
        init: init,
        listSessions: listSessions,
        getSession: getSession,
        putSession: putSession,
        deleteSession: deleteSession,
        listMessages: listMessages,
        putMessage: putMessage,
        deleteMessage: deleteMessage,
        listCards: listCards,
        putCard: putCard,
        deleteCard: deleteCard,
        getSetting: getSetting,
        putSetting: putSetting,
        deleteSetting: deleteSetting,
        getAllMessages: getAllMessages,
        searchMessages: searchMessages,
        importAll: importAll
    };
})();
