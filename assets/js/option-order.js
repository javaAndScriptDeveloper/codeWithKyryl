// Display order for a question's options. Authored data puts most correct answers first,
// so options are shuffled on every render; true/false keeps its conventional order.
// Returns original option indexes in display order, so scoring and stored picks stay
// keyed by the authored index.
(function () {
    function optionOrder(question, random) {
        const order = question.options.map(function (_, index) { return index; });
        if (question.type === 'boolean') return order;

        for (let i = order.length - 1; i > 0; i -= 1) {
            const j = Math.floor(random() * (i + 1));
            const swap = order[i];
            order[i] = order[j];
            order[j] = swap;
        }
        return order;
    }

    if (typeof module === 'object' && module.exports) module.exports = { optionOrder };
    else window.optionOrder = optionOrder;
}());
