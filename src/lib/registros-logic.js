// Lógica pura do módulo de Registros.
// Consumido tanto pelo renderer Electron (src/scripts/registros/registros.js)
// quanto pelos testes Jest (tests/registros.test.js, tests/relatorio.test.js,
// tests/utilitarios.test.js). Não acessa DOM, electron nem disco.

const MESES_PT = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

function formatarData(dataString) {
    if (!dataString) return '';
    try {
        const data = new Date(dataString);
        if (isNaN(data.getTime())) return 'Data inválida';
        return data.toLocaleString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return 'Data inválida';
    }
}

function filtrarPorTexto(registros, texto) {
    const lista = Array.isArray(registros) ? registros : [];
    const termo = String(texto || '').toLowerCase();
    if (!termo) return [...lista];
    return lista.filter(r =>
        Object.values(r).some(v => String(v).toLowerCase().includes(termo))
    );
}

function filtrarAvancado(registros, { modalidade, inicio, fim } = {}) {
    const lista = Array.isArray(registros) ? registros : [];
    const dataInicio = inicio ? new Date(inicio) : null;
    const dataFim = fim ? new Date(fim) : null;
    return lista.filter(r => {
        const dataExame = new Date(r.dataHoraExame);
        const passaModalidade = !modalidade || r.modalidade === modalidade;
        const passaData =
            (!dataInicio || dataExame >= dataInicio) &&
            (!dataFim || dataExame <= dataFim);
        return passaModalidade && passaData;
    });
}

function ordenarRegistros(registros, campo, ordem = 'asc') {
    const direcao = ordem === 'desc' ? -1 : 1;
    const copia = [...(Array.isArray(registros) ? registros : [])];
    copia.sort((a, b) => {
        if (campo === 'dataHoraExame') {
            const da = new Date(a[campo]);
            const db = new Date(b[campo]);
            const va = isNaN(da.getTime()) ? 0 : da.getTime();
            const vb = isNaN(db.getTime()) ? 0 : db.getTime();
            return (va - vb) * direcao;
        }
        return String(a[campo] ?? '')
            .toLowerCase()
            .localeCompare(String(b[campo] ?? '').toLowerCase()) * direcao;
    });
    return copia;
}

function validarFormatoImportacao(registros) {
    if (!Array.isArray(registros)) return false;
    if (registros.length === 0) return false;
    return registros.every(r =>
        r != null &&
        Object.prototype.hasOwnProperty.call(r, 'nomePaciente') &&
        Object.prototype.hasOwnProperty.call(r, 'modalidade') &&
        Object.prototype.hasOwnProperty.call(r, 'numeroAcesso')
    );
}

function mesclarRegistros(existentes, novos) {
    const base = Array.isArray(existentes) ? existentes : [];
    const incoming = Array.isArray(novos) ? novos : [];
    const idsExistentes = new Set(base.map(r => r.id));
    const adicionais = incoming.filter(r => !idsExistentes.has(r.id));
    return [...base, ...adicionais];
}

function paginar(registros, registrosPorPagina, paginaAtual) {
    const lista = Array.isArray(registros) ? registros : [];
    const tamanhoPagina = Math.max(0, Number(registrosPorPagina) || 0);
    const pagina = Math.max(1, Number(paginaAtual) || 1);
    const total = lista.length;
    const fim = Math.min(tamanhoPagina * pagina, total);
    return {
        itens: lista.slice(0, fim),
        exibidos: fim,
        total,
        temMais: fim < total
    };
}

function agruparPorMes(registros, ano) {
    const resultado = {};
    MESES_PT.forEach(m => { resultado[m] = 0; });
    (Array.isArray(registros) ? registros : []).forEach(r => {
        if (!r || !r.dataHoraExame) return;
        const d = new Date(r.dataHoraExame);
        if (isNaN(d.getTime())) return;
        if (ano && d.getFullYear().toString() !== String(ano)) return;
        resultado[MESES_PT[d.getMonth()]]++;
    });
    return resultado;
}

function contarPorModalidade(registros) {
    const totais = {};
    (Array.isArray(registros) ? registros : []).forEach(r => {
        const m = r.modalidade || 'Não especificado';
        totais[m] = (totais[m] || 0) + 1;
    });
    return totais;
}

function formatCsvField(value, maxWidth) {
    if (value === null || value === undefined) value = '';
    value = value.toString().replace(/[\r\n]+/g, ' ').replace(/,/g, ';');
    if (maxWidth && value.length > maxWidth) {
        value = value.substring(0, maxWidth - 3) + '...';
    }
    value = value.replace(/"/g, '""');
    return `"${value}"`;
}

function criarRegistro(dados, registroExistente = null) {
    const fonte = dados || {};
    return {
        id: registroExistente ? registroExistente.id : Date.now(),
        nomePaciente: (fonte.nomePaciente || '').trim(),
        modalidade: fonte.modalidade || '',
        observacoes: (fonte.observacoes || '').trim(),
        numeroAcesso: (fonte.numeroAcesso || '').trim(),
        dataHoraExame: fonte.dataHoraExame || '',
        nomeTecnico: (fonte.nomeTecnico || '').trim()
    };
}

function excluirRegistro(registros, id) {
    return (Array.isArray(registros) ? registros : []).filter(r => r.id !== id);
}

function extrairAnosDisponiveis(registros) {
    const anos = new Set();
    (registros || []).forEach(r => {
        if (!r || !r.dataHoraExame) return;
        const d = new Date(r.dataHoraExame);
        if (!isNaN(d.getTime())) anos.add(d.getFullYear().toString());
    });
    return Array.from(anos).sort((a, b) => parseInt(b) - parseInt(a));
}

function cpfSomenteDigitos(valor) {
    return String(valor || '').replace(/\D/g, '');
}

function extrairCpfOuProntuarioLegado(documento) {
    const valor = String(documento || '').trim();
    if (!valor) return { cpfPaciente: '', prontuarioPaciente: '' };

    const upper = valor.toUpperCase();
    if (/^P\d{1,10}$/.test(upper)) {
        return { cpfPaciente: '', prontuarioPaciente: upper };
    }

    const cpf = cpfSomenteDigitos(valor);
    if (cpf.length === 11) {
        return { cpfPaciente: cpf, prontuarioPaciente: '' };
    }

    return { cpfPaciente: '', prontuarioPaciente: upper };
}

function obterProximoProntuario(pacientes = [], registros = []) {
    const usados = new Set();
    [...(pacientes || []), ...(registros || [])].forEach(item => {
        const prontuario = String(item?.prontuarioPaciente || item?.documentoPaciente || '').trim().toUpperCase();
        if (prontuario) usados.add(prontuario);
    });

    let seq = 1;
    for (const valor of usados) {
        const m = valor.match(/^P(\d{1,10})$/);
        if (m) seq = Math.max(seq, Number(m[1]) + 1);
    }

    let candidato = `P${String(seq).padStart(6, '0')}`;
    while (usados.has(candidato)) {
        seq += 1;
        candidato = `P${String(seq).padStart(6, '0')}`;
    }
    return candidato;
}

function obterProximoNumeroAcesso(registros = []) {
    const usados = new Set(
        (registros || []).map(r => String(r.numeroAcesso || '').trim()).filter(Boolean)
    );
    let seq = 1;
    for (const valor of usados) {
        if (/^\d{1,12}$/.test(valor)) {
            seq = Math.max(seq, Number(valor) + 1);
        }
    }

    let candidato = String(seq).padStart(7, '0');
    while (usados.has(candidato)) {
        seq += 1;
        candidato = String(seq).padStart(7, '0');
    }
    return candidato;
}

function normalizarRegistro(registro) {
    const r = registro || {};
    const legado = extrairCpfOuProntuarioLegado(r.documentoPaciente || r.pacienteDocumento || '');
    const prontuarioPaciente = String(r.prontuarioPaciente || legado.prontuarioPaciente || '').trim().toUpperCase();
    const cpfPaciente = cpfSomenteDigitos(r.cpfPaciente || legado.cpfPaciente || '');
    return {
        ...r,
        statusExame: r.statusExame || 'Agendado',
        cpfPaciente,
        prontuarioPaciente,
        documentoPaciente: prontuarioPaciente || r.documentoPaciente || r.pacienteDocumento || '',
        pacienteId: r.pacienteId || ''
    };
}

module.exports = {
    MESES_PT,
    formatarData,
    filtrarPorTexto,
    filtrarAvancado,
    ordenarRegistros,
    validarFormatoImportacao,
    mesclarRegistros,
    paginar,
    agruparPorMes,
    contarPorModalidade,
    formatCsvField,
    criarRegistro,
    excluirRegistro,
    extrairAnosDisponiveis,
    cpfSomenteDigitos,
    extrairCpfOuProntuarioLegado,
    obterProximoProntuario,
    obterProximoNumeroAcesso,
    normalizarRegistro
};
