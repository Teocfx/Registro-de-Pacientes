// Lógica pura do módulo de Ocorrências (SLA, prioridade, status).
// Consumida tanto por src/scripts/ocorrencias/ocorrencias.js quanto pelos testes.

const REGEX_DIACRITICOS = /[̀-ͯ]/g;

function toIsoDateOnly(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
}

function normalizarPrioridade(valor) {
    const v = String(valor || '').trim().toLowerCase();
    if (v === 'alta') return 'Alta';
    if (v === 'baixa') return 'Baixa';
    return 'Media';
}

function obterStatusNormalizado(valor) {
    return String(valor || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(REGEX_DIACRITICOS, '')
        .trim();
}

// Regra de SLA: Alta=1 dia, Media=3 dias, Baixa=5 dias após a data base.
function calcularPrazoEfetivo(ocorrencia) {
    const o = ocorrencia || {};
    const prazoDireto = toIsoDateOnly(o.prazo || '');
    if (prazoDireto) return prazoDireto;
    const dataBase = toIsoDateOnly(o.data || '');
    if (!dataBase) return '';

    const base = new Date(`${dataBase}T00:00:00`);
    if (Number.isNaN(base.getTime())) return '';
    const prioridade = normalizarPrioridade(o.prioridade);
    const dias = prioridade === 'Alta' ? 1 : (prioridade === 'Baixa' ? 5 : 3);
    base.setDate(base.getDate() + dias);
    return base.toISOString().slice(0, 10);
}

// `hojeIso` é injetável para tornar a função determinística nos testes.
function calcularSla(ocorrencia, hojeIso = null) {
    const statusNorm = obterStatusNormalizado(ocorrencia?.status);
    if (statusNorm === 'concluido') return 'Concluida';
    const prazo = calcularPrazoEfetivo(ocorrencia);
    if (!prazo) return 'Sem prazo';

    let referencia = hojeIso;
    if (!referencia) {
        const hoje = new Date();
        const hojeLocal = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
        referencia = hojeLocal.toISOString().slice(0, 10);
    }

    if (prazo < referencia) return 'Atrasada';
    if (prazo === referencia) return 'Vence hoje';
    return 'No prazo';
}

module.exports = {
    toIsoDateOnly,
    normalizarPrioridade,
    obterStatusNormalizado,
    calcularPrazoEfetivo,
    calcularSla
};
