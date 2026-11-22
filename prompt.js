/* 听澜 2 · 提示词组装
   三层结构（这是"活人感"的关键）：
   1. 行为准则：所有角色共用，管"不许干什么"，放在最前 + 最后重申
   2. 人设：角色卡 / 我的角色 / 故事背景，管"是谁"
   3. 文体：写作预设，管"怎么写"
*/
'use strict';

const Prompt = (function () {

    const DEFAULT_BEHAVIOR = [
        '你正在与用户共同创作一段故事，请严格遵守：',
        '1. 只写你自己的角色。不要替用户说话、行动或做决定，也不要描写用户的心理和感受。',
        '2. 不要总结前文，不要解释角色的情绪或动机，不要写“我理解你的意思”这类旁白。',
        '3. 每次只推进一小步，篇幅遵循【写作要求】；没有特别要求时控制在 150–350 字。',
        '4. 用具体的动作、语气、停顿、细节来表达情绪，避免“仿佛、似乎、一丝、不易察觉”这类空泛词汇。',
        '5. 不要跳出角色，不要以助手身份解释或道歉。保持人物前后一致。'
    ].join('\n');

    function defaultPresets() {
        return [
            {
                id: 'preset-rp',
                name: '角色扮演',
                writing: '第三人称限知视角，只写你的角色能感知到的内容。动作与对白交替，避免大段心理剖析。',
                dialogue: '说话简短、口语化，允许停顿和答非所问。称呼对方用“你”。',
                theme: '',
                bannedWords: '仿佛、似乎、一丝、不易察觉、嘴角勾起、眼中闪过、意味深长',
                taboos: '不要总结剧情，不要替对方做决定',
                auxiliary: ''
            },
            {
                id: 'preset-novel',
                name: '小说创作',
                writing: '叙述流畅，段落分明，每次 400–800 字。场景描写服务于人物动作，不堆砌形容词。',
                dialogue: '对白自然，符合人物身份，避免说明文式解释。',
                theme: '',
                bannedWords: '仿佛、似乎、一丝、不易察觉',
                taboos: '不要写“本章完”“接下来”这类作者旁白',
                auxiliary: ''
            }
        ];
    }

    const CARD_FIELDS = [
        ['gender', '性别'],
        ['age', '年龄'],
        ['identity', '身份'],
        ['appearance', '外貌'],
        ['personality', '性格'],
        ['core', '核心人格'],
        ['backstory', '人物经历'],
        ['attitude', '感情与态度'],
        ['extra', '补充设定']
    ];

    function appendCard(parts, heading, card, attitudeLabel, note) {
        if (!card || !card.name) return;
        const lines = [heading];
        lines.push('姓名：' + card.name);
        CARD_FIELDS.forEach(function (entry) {
            const key = entry[0];
            const label = key === 'attitude' ? attitudeLabel : entry[1];
            const value = card[key];
            if (value && String(value).trim()) lines.push(label + '：' + String(value).trim());
        });
        if (note) lines.push(note);
        parts.push(lines.join('\n'));
    }

    /**
     * @param {object} session 当前对话（含 aiCard / userCard / scene）
     * @param {object} settings { preset, behavior }
     * @returns {string} 拼好的 system 提示词；没有设定时返回空串
     */
    function build(session, settings) {
        if (!session) return '';
        const ai = session.aiCard || {};
        const me = session.userCard || {};
        const scene = session.scene || {};
        const preset = (settings && settings.preset) || {};
        const behavior = (settings && settings.behavior) || '';

        const hasScene = !!(scene.world || scene.plot || scene.opening);
        const hasRoleplay = !!(ai.name || hasScene);
        const presetKeys = ['writing', 'dialogue', 'theme', 'bannedWords', 'taboos', 'auxiliary'];
        const hasPreset = presetKeys.some(function (key) { return (preset[key] || '').trim(); });

        if (!hasRoleplay && !hasPreset) return '';

        const parts = [];

        if (hasRoleplay && behavior.trim()) {
            parts.push('【行为准则 · 最高优先级】\n' + behavior.trim());
        }

        if (hasPreset) {
            if ((preset.writing || '').trim()) parts.push('【写作要求】\n' + preset.writing.trim());
            if ((preset.dialogue || '').trim()) parts.push('【对话要求】\n' + preset.dialogue.trim());
            if ((preset.theme || '').trim()) parts.push('【对话主旨】\n' + preset.theme.trim());
            if ((preset.bannedWords || '').trim()) parts.push('【避免使用的词】\n' + preset.bannedWords.trim());
            if ((preset.taboos || '').trim()) parts.push('【禁忌】\n' + preset.taboos.trim());
            if ((preset.auxiliary || '').trim()) parts.push('【补充要求】\n' + preset.auxiliary.trim());
        }

        if (hasScene) {
            const sceneLines = ['【故事背景】'];
            if (scene.world) sceneLines.push('世界观：' + scene.world.trim());
            if (scene.plot) sceneLines.push('前置剧情：' + scene.plot.trim());
            if (scene.opening) sceneLines.push('当前场景：' + scene.opening.trim());
            parts.push(sceneLines.join('\n'));
        }

        appendCard(parts, '【用户扮演的角色】', me, '对 AI 角色的感情与态度', '请把对方当作这个角色，用符合你们关系的方式回应。');

        if (ai.name) {
            const lines = ['【你扮演的角色】', '你现在的名字是' + ai.name + '，请完全代入这个角色，不要跳出。'];
            CARD_FIELDS.forEach(function (entry) {
                const key = entry[0];
                const label = key === 'attitude' ? '对用户的感情与态度' : entry[1];
                const value = ai[key];
                if (value && String(value).trim()) lines.push(label + '：' + String(value).trim());
            });
            parts.push(lines.join('\n'));
        }

        if (hasRoleplay) {
            parts.push([
                '【最后重申 · 优先级最高】',
                '严格遵守上面的行为准则，尤其是：不替用户说话、行动或做决定；不描写用户内心；不总结前文；不以助手身份解释或道歉。',
                '直接输出角色此刻的言行，不要加任何说明性文字。'
            ].join('\n'));
        }

        return parts.join('\n\n');
    }

    return {
        DEFAULT_BEHAVIOR: DEFAULT_BEHAVIOR,
        defaultPresets: defaultPresets,
        build: build,
        CARD_FIELDS: CARD_FIELDS
    };
})();
