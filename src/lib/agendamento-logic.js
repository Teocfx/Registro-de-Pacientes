// Lógica pura do módulo de Agendamento (horários, conflitos, períodos).

function slugifyId(texto) {
    return String(texto || '')
        .normalize('NFD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-');
}

function removerAcentos(texto) {
    return String(texto || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
}

function parseHoraParaMinutos(hhmm) {
    const partes = String(hhmm || '').split(':');
    if (partes.length !== 2) return 0;
    const h = Number(partes[0]);
    const m = Number(partes[1]);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
    return h * 60 + m;
}

function formatarMinutosParaHora(totalMin) {
    const min = Math.max(0, Number(totalMin) || 0);
    const h = String(Math.floor(min / 60)).padStart(2, '0');
    const m = String(min % 60).padStart(2, '0');
    return `${h}:${m}`;
}

function obterDataLocalIso(data = new Date()) {
    const d = data instanceof Date ? data : new Date(data);
    if (Number.isNaN(d.getTime())) return '';
    const ano = d.getFullYear();
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const dia = String(d.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
}

function obterDatasPeriodo(periodo, dataReferenciaIso) {
    const base = new Date(`${dataReferenciaIso}T00:00:00`);
    if (Number.isNaN(base.getTime())) return [];

    if (periodo === 'dia') {
        return [dataReferenciaIso];
    }

    if (periodo === 'semana') {
        const diaSemana = base.getDay();
        const inicioSemana = new Date(base);
        inicioSemana.setDate(base.getDate() - diaSemana);
        return Array.from({ length: 7 }, (_, idx) => {
            const data = new Date(inicioSemana);
            data.setDate(inicioSemana.getDate() + idx);
            return obterDataLocalIso(data);
        });
    }

    if (periodo === 'mes') {
        const ano = base.getFullYear();
        const mes = base.getMonth();
        const diasNoMes = new Date(ano, mes + 1, 0).getDate();
        return Array.from({ length: diasNoMes }, (_, idx) => {
            const data = new Date(ano, mes, idx + 1);
            return obterDataLocalIso(data);
        });
    }

    const ano = base.getFullYear();
    return Array.from({ length: 12 }, (_, idx) => {
        const data = new Date(ano, idx, 1);
        return obterDataLocalIso(data);
    });
}

function normalizarDatasBloqueadas(datas) {
    if (!Array.isArray(datas)) return [];
    return [...new Set(
        datas
            .map(item => String(item || '').trim())
            .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item))
    )].sort();
}

// Conflito é apurado contra a lista de agendamentos passada — função pura.
function conflitoDeAgenda(agendamentos, { medicoId, dataHora, ignorarAgendamentoId = null } = {}) {
    return (Array.isArray(agendamentos) ? agendamentos : []).some(a =>
        a &&
        a.id !== ignorarAgendamentoId &&
        a.medicoId === medicoId &&
        a.statusExame !== 'Cancelado' &&
        String(a.dataHora || '') === String(dataHora || '')
    );
}

function gerarHorariosDisponiveis(medico, dataIso, agendamentos = [], agendamentoEditandoId = null) {
    if (!medico || !dataIso) return [];
    if (normalizarDatasBloqueadas(medico.datasBloqueadas).includes(dataIso)) return [];

    const base = new Date(`${dataIso}T00:00:00`);
    if (Number.isNaN(base.getTime())) return [];

    const diaSemana = base.getDay();
    const diasPermitidos = Array.isArray(medico.diasSemana) ? medico.diasSemana : [];
    if (!diasPermitidos.includes(diaSemana)) return [];

    const inicio = parseHoraParaMinutos(medico.inicio);
    const fim = parseHoraParaMinutos(medico.fim);
    const intervaloBruto = Number(medico.intervaloMinutos);
    if (!Number.isFinite(intervaloBruto) || intervaloBruto <= 0) return [];
    if (fim <= inicio) return [];
    const intervalo = intervaloBruto;

    const slots = [];
    for (let minuto = inicio; minuto + intervalo <= fim; minuto += intervalo) {
        const hora = formatarMinutosParaHora(minuto);
        const ocupado = conflitoDeAgenda(agendamentos, {
            medicoId: medico.id,
            dataHora: `${dataIso}T${hora}`,
            ignorarAgendamentoId: agendamentoEditandoId
        });
        if (!ocupado) slots.push(hora);
    }
    return slots;
}

module.exports = {
    slugifyId,
    removerAcentos,
    parseHoraParaMinutos,
    formatarMinutosParaHora,
    obterDataLocalIso,
    obterDatasPeriodo,
    normalizarDatasBloqueadas,
    conflitoDeAgenda,
    gerarHorariosDisponiveis
};
