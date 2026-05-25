// Lógica pura do módulo de Ponto (cálculo de horas e validação).

function parseHora(hhmm) {
    if (!hhmm || typeof hhmm !== 'string') return null;
    const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
}

// Calcula horas trabalhadas entre duas marcações "HH:MM". Suporta virada de dia
// (saída < entrada => assume passagem de meia-noite).
function calcularHorasTrabalhadas(entrada, saida) {
    if (!entrada || !saida) return 0;
    const entradaMin = parseHora(entrada);
    const saidaMin = parseHora(saida);
    if (entradaMin === null || saidaMin === null) return 0;
    let delta = saidaMin - entradaMin;
    if (delta < 0) delta += 24 * 60; // virada de dia
    return delta / 60;
}

function calcularHorasDoRegistro(registro) {
    const r = registro || {};
    const manha = calcularHorasTrabalhadas(r.turno_manha_entrada, r.turno_manha_saida);
    const tarde = calcularHorasTrabalhadas(r.turno_tarde_entrada, r.turno_tarde_saida);
    return manha + tarde;
}

function validarRegistro(registro) {
    const r = registro || {};
    if (!r.data) return { ok: false, mensagem: 'Data é obrigatória' };
    if (!r.turno_manha_entrada && !r.turno_tarde_entrada) {
        return { ok: false, mensagem: 'Pelo menos um turno deve ser preenchido' };
    }
    return { ok: true };
}

function filtrarRegistrosPorMes(registros, mesIso) {
    if (!Array.isArray(registros)) return [];
    if (!mesIso || typeof mesIso !== 'string') return [...registros];
    return registros.filter(r => String(r?.data || '').startsWith(mesIso));
}

module.exports = {
    parseHora,
    calcularHorasTrabalhadas,
    calcularHorasDoRegistro,
    validarRegistro,
    filtrarRegistrosPorMes
};
