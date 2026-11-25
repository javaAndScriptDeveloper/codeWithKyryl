// Small language tag ("JAVA", "SQL") on each highlighted code block, so readers can tell
// a JPA query from a migration at a glance. Pure helper is exported for node tests.
(function () {
    const NAMES = {
        java: 'Java', kotlin: 'Kotlin', sql: 'SQL', yaml: 'YAML', yml: 'YAML', json: 'JSON',
        bash: 'Bash', shell: 'Shell', sh: 'Shell', python: 'Python', javascript: 'JavaScript',
        js: 'JavaScript', typescript: 'TypeScript', ts: 'TypeScript', xml: 'XML', html: 'HTML',
        properties: 'Properties', dockerfile: 'Dockerfile', groovy: 'Groovy', go: 'Go'
    };
    const NO_LABEL = new Set(['plaintext', 'text', 'mermaid', 'console', 'output']);

    function languageLabel(className) {
        const match = /(?:^|\s)language-([\w+-]+)/.exec(className || '');
        if (!match) return null;
        const lang = match[1].toLowerCase();
        if (NO_LABEL.has(lang)) return null;
        return NAMES[lang] || lang.toUpperCase();
    }

    function mount(root) {
        root.querySelectorAll('div.highlighter-rouge').forEach(function (block) {
            const label = languageLabel(block.className);
            if (!label || !block.querySelector('pre') || block.querySelector('.code-lang')) return;
            const tag = document.createElement('span');
            tag.className = 'code-lang';
            tag.textContent = label;
            block.appendChild(tag);
        });
    }

    const CodeLabel = { languageLabel, mount };
    if (typeof module === 'object' && module.exports) module.exports = CodeLabel;
    else window.CodeLabel = CodeLabel;
}());
