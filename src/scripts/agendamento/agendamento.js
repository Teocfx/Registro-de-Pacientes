const { ipcRenderer } = require('electron');

async function garantirAcesso(rolesPermitidos) {
    const session = await ipcRenderer.invoke('auth-get-session');
    if (!session) {
        window.location.href = '../auth/login.html';
        throw new Error('Sessao nao autenticada');
    }

    const role = String(session.role || '').toLowerCase();
    if (Array.isArray(rolesPermitidos) && rolesPermitidos.length > 0 && !rolesPermitidos.includes(role)) {
        window.location.href = '../index.html';
        throw new Error('Sem permissao para este modulo');
    }

    return session;
}

const DEFAULT_MEDICOS_AGENDA = [
    {
        id: 'ronny',
        nome: 'Ronny',
        diasSemana: [1, 2, 4],
        inicio: '07:00',
        fim: '13:00',
        intervaloMinutos: 30
    },
    {
        id: 'germana',
        nome: 'Germana',
        diasSemana: [1, 3, 5],
        inicio: '08:00',
        fim: '14:00',
        intervaloMinutos: 30
    },
    {
        id: 'bento',
        nome: 'Bento',
        diasSemana: [2, 4, 6],
        inicio: '09:00',
        fim: '15:00',
        intervaloMinutos: 30
    }
];

const DIAS_NOME = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

let medicosAgenda = [];
let agendamentos = [];
let agendamentosFiltrados = [];
let registros = [];
let pacientes = [];
let selecionado = null;
let selecionadoAgendaMedico = null;
let datasBloqueadasAgendaMedico = [];
let configSistema = {};
const dataVersions = {
    config: 0,
    'medicos-agenda': 0,
    agendamentos: 0,
    registros: 0,
    pacientes: 0
};
let pacienteBaseNoNovo = null;
let resolverConfirmacao = null;
let resolverAviso = null;
let contextoImpressao = null;

window.addEventListener('error', (event) => {
    console.error('Erro global em Agendamento:', event.error || event.message);
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('Promise rejeitada em Agendamento:', event.reason);
});

function obterContadoresConfig() {
    if (!configSistema || typeof configSistema !== 'object') configSistema = {};
    if (!configSistema.contadores || typeof configSistema.contadores !== 'object') {
        configSistema.contadores = {};
    }
    if (!Number.isFinite(Number(configSistema.contadores.prontuarioAtual))) {
        configSistema.contadores.prontuarioAtual = 0;
    }
    if (!Number.isFinite(Number(configSistema.contadores.numeroAcessoAtual))) {
        configSistema.contadores.numeroAcessoAtual = 0;
    }
    return configSistema.contadores;
}

function formatarProntuarioSequencial(numero) {
    return `P${String(numero).padStart(6, '0')}`;
}

function formatarNumeroAcessoSequencial(numero) {
    return String(numero).padStart(7, '0');
}

function extrairNumeroProntuario(valor) {
    const normalizado = String(valor || '').trim().toUpperCase();
    const match = normalizado.match(/^P(\d{1,10})$/);
    return match ? Number(match[1]) : null;
}

function extrairNumeroAcesso(valor) {
    const normalizado = String(valor || '').trim();
    if (!/^\d{1,12}$/.test(normalizado)) return null;
    return Number(normalizado);
}

function cpfSomenteDigitos(valor) {
    return String(valor || '').replace(/\D/g, '');
}

function idsIguais(a, b) {
    return String(a ?? '').trim() !== '' && String(a) === String(b);
}

function extrairIdRegistroOrigem(idOrigem) {
    const raw = String(idOrigem || '');
    return raw.startsWith('reg-') ? raw.slice(4) : raw;
}

function escapeHtml(valor) {
    return String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
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

function obterChavePaciente(item = {}) {
    return String(item.prontuarioPaciente || item.documentoPaciente || item.cpfPaciente || '').trim().toLowerCase();
}

function coletarDocumentosUsados() {
    return new Set([
        ...pacientes.map(p => String(p.prontuarioPaciente || p.documentoPaciente || '').trim().toUpperCase()),
        ...agendamentos.map(a => String(a.prontuarioPaciente || a.documentoPaciente || '').trim().toUpperCase()),
        ...registros.map(r => String(r.documentoPaciente || '').trim().toUpperCase())
    ].filter(Boolean));
}

function coletarAcessosUsados(ignorarAgendamentoId = null) {
    const usados = new Set();

    agendamentos.forEach(a => {
        if (ignorarAgendamentoId && a.id === ignorarAgendamentoId) return;
        const acesso = String(a.numeroAcesso || '').trim();
        if (acesso) usados.add(acesso);
    });

    registros.forEach(r => {
        const acesso = String(r.numeroAcesso || '').trim();
        if (acesso) usados.add(acesso);
    });

    return usados;
}

function existeCpfDuplicado(cpf, ignorarPacienteId = '') {
    const valor = cpfSomenteDigitos(cpf);
    if (!valor) return false;
    return pacientes.some(p =>
        p.id !== ignorarPacienteId &&
        cpfSomenteDigitos(p.cpfPaciente || '') === valor
    );
}

function existeProntuarioDuplicado(prontuario, ignorarPacienteId = '') {
    const valor = String(prontuario || '').trim().toUpperCase();
    if (!valor) return false;
    return pacientes.some(p =>
        p.id !== ignorarPacienteId &&
        String(p.prontuarioPaciente || p.documentoPaciente || '').trim().toUpperCase() === valor
    );
}

function obterMaiorProntuarioExistente() {
    let maior = 0;
    coletarDocumentosUsados().forEach(doc => {
        const numero = extrairNumeroProntuario(doc);
        if (Number.isFinite(numero)) maior = Math.max(maior, numero);
    });
    return maior;
}

function obterMaiorNumeroAcessoExistente() {
    let maior = 0;
    coletarAcessosUsados().forEach(acesso => {
        const numero = extrairNumeroAcesso(acesso);
        if (Number.isFinite(numero)) maior = Math.max(maior, numero);
    });
    return maior;
}

function sugerirProximoProntuario() {
    const contadores = obterContadoresConfig();
    let proximo = Math.max(Number(contadores.prontuarioAtual) || 0, obterMaiorProntuarioExistente()) + 1;
    const usados = coletarDocumentosUsados();
    let codigo = formatarProntuarioSequencial(proximo);

    while (usados.has(codigo.toUpperCase())) {
        proximo += 1;
        codigo = formatarProntuarioSequencial(proximo);
    }
    return codigo;
}

function sugerirProximoNumeroAcesso(ignorarAgendamentoId = null) {
    const contadores = obterContadoresConfig();
    let proximo = Math.max(Number(contadores.numeroAcessoAtual) || 0, obterMaiorNumeroAcessoExistente()) + 1;
    const usados = coletarAcessosUsados(ignorarAgendamentoId);
    let codigo = formatarNumeroAcessoSequencial(proximo);

    while (usados.has(codigo)) {
        proximo += 1;
        codigo = formatarNumeroAcessoSequencial(proximo);
    }
    return codigo;
}

function consumirProximoProntuario() {
    const codigo = sugerirProximoProntuario();
    const numero = extrairNumeroProntuario(codigo);
    const contadores = obterContadoresConfig();
    contadores.prontuarioAtual = Math.max(Number(contadores.prontuarioAtual) || 0, Number(numero) || 0);
    return codigo;
}

function consumirProximoNumeroAcesso(ignorarAgendamentoId = null) {
    const codigo = sugerirProximoNumeroAcesso(ignorarAgendamentoId);
    const numero = extrairNumeroAcesso(codigo);
    const contadores = obterContadoresConfig();
    contadores.numeroAcessoAtual = Math.max(Number(contadores.numeroAcessoAtual) || 0, Number(numero) || 0);
    return codigo;
}

async function carregarConfigSistema() {
    const dados = await ipcRenderer.invoke('ler-config');
    try {
        const v = await ipcRenderer.invoke('data-get-version', 'config');
        dataVersions.config = Number(v?.version || 0);
    } catch (error) {
        console.warn('Falha ao obter versão de config:', error);
        dataVersions.config = 0;
    }
    configSistema = (dados && typeof dados === 'object') ? dados : {};
    obterContadoresConfig();
}

async function salvarConfigSistema() {
    const ok = await ipcRenderer.invoke('salvar-config', {
        data: configSistema,
        expectedVersion: dataVersions.config,
        detalhe: 'Atualizacao de configuracao pelo agendamento'
    });
    if (!ok) throw new Error('Falha ao salvar configuração (possível conflito).');
    const v = await ipcRenderer.invoke('data-get-version', 'config');
    dataVersions.config = Number(v?.version || dataVersions.config);
}

function obterPacienteBaseSelecionado() {
    if (!selecionado) return null;

    const paciente = pacientes.find(p =>
        (p.id && p.id === selecionado.pacienteId) ||
        (p.prontuarioPaciente || p.documentoPaciente || '').trim().toLowerCase() === (selecionado.prontuarioPaciente || selecionado.documentoPaciente || '').trim().toLowerCase() ||
        cpfSomenteDigitos(p.cpfPaciente || '') === cpfSomenteDigitos(selecionado.cpfPaciente || '')
    );

    return {
        id: paciente?.id || selecionado.pacienteId || '',
        nomePaciente: selecionado.nomePaciente || paciente?.nomePaciente || '',
        cpfPaciente: selecionado.cpfPaciente || paciente?.cpfPaciente || '',
        prontuarioPaciente: selecionado.prontuarioPaciente || selecionado.documentoPaciente || paciente?.prontuarioPaciente || paciente?.documentoPaciente || '',
        telefonePaciente: selecionado.telefonePaciente || paciente?.telefonePaciente || '',
        dataNascimentoPaciente: selecionado.dataNascimentoPaciente || paciente?.dataNascimentoPaciente || '',
        enderecoPaciente: selecionado.enderecoPaciente || paciente?.enderecoPaciente || '',
        planoPaciente: selecionado.planoPaciente || paciente?.planoPaciente || ''
    };
}

function setTheme(theme) {
    if (document.body) document.body.classList.remove('dark-theme', 'light-theme', 'theme-azul');
    if (document.documentElement) document.documentElement.classList.remove('dark-theme', 'light-theme', 'theme-azul');

    if (theme === 'dark') {
        document.body.classList.add('dark-theme');
        document.documentElement.classList.add('dark-theme');
    } else if (theme === 'light') {
        document.body.classList.add('light-theme');
        document.documentElement.classList.add('light-theme');
    } else if (theme === 'blue' || theme === 'azul') {
        document.body.classList.add('theme-azul');
        document.documentElement.classList.add('theme-azul');
    }
}

function carregarTema() {
    setTheme(localStorage.getItem('theme') || 'light');
}

function obterDataHojeIso() {
    return new Date().toISOString().slice(0, 10);
}

function slugifyId(texto) {
    return String(texto || '')
        .normalize('NFD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-');
}

function parseHoraParaMinutos(hhmm) {
    const [h, m] = String(hhmm || '').split(':').map(Number);
    return h * 60 + m;
}

function formatarMinutosParaHora(totalMin) {
    const h = String(Math.floor(totalMin / 60)).padStart(2, '0');
    const m = String(totalMin % 60).padStart(2, '0');
    return `${h}:${m}`;
}

function formatarData(dataIso) {
    if (!dataIso) return '';
    const data = new Date(dataIso);
    if (Number.isNaN(data.getTime())) return '';
    return data.toLocaleString('pt-BR');
}

function formatarDataIsoParaBr(dataIso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dataIso || ''))) return dataIso || '';
    const [ano, mes, dia] = dataIso.split('-');
    return `${dia}/${mes}/${ano}`;
}

function removerAcentos(texto) {
    return String(texto || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

function obterTermoBusca() {
    return removerAcentos(document.getElementById('pesquisa')?.value || '').toLowerCase().trim();
}

function obterDataLocalIso(data = new Date()) {
    const ano = data.getFullYear();
    const mes = String(data.getMonth() + 1).padStart(2, '0');
    const dia = String(data.getDate()).padStart(2, '0');
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

function normalizarStatusParaClasse(status) {
    return String(status || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-');
}

function atualizarMetricasPainel(itens = []) {
    const base = Array.isArray(itens) ? itens : [];
    const total = base.length;
    const agendado = base.filter(a => a.statusExame === 'Agendado').length;
    const realizado = base.filter(a => a.statusExame === 'Realizado').length;
    const cancelado = base.filter(a => a.statusExame === 'Cancelado').length;

    const byId = (id) => document.getElementById(id);
    if (byId('metricTotal')) byId('metricTotal').textContent = String(total);
    if (byId('metricAgendado')) byId('metricAgendado').textContent = String(agendado);
    if (byId('metricRealizado')) byId('metricRealizado').textContent = String(realizado);
    if (byId('metricCancelado')) byId('metricCancelado').textContent = String(cancelado);
}

function atualizarResumoTabela() {
    const resumo = document.getElementById('tableSummary');
    if (!resumo) return;

    const termo = obterTermoBusca();
    const totalFiltrado = agendamentosFiltrados.length;
    const totalGeral = obterItensTabelaAgendamento('').length;
    const sufixoSelecao = selecionado ? ' | 1 item selecionado' : '';

    if (totalGeral === 0) {
        resumo.textContent = 'Nenhum agendamento ou registro cadastrado.';
        return;
    }

    if (totalFiltrado === 0) {
        resumo.textContent = termo
            ? 'Nenhum paciente encontrado para a busca informada.'
            : 'Nenhum item disponível para exibir.';
        return;
    }

    resumo.textContent = termo
        ? `${totalFiltrado} paciente(s) encontrado(s)${sufixoSelecao}`
        : `Exibindo ${totalFiltrado} paciente(s)${sufixoSelecao}`;
}

function normalizarDatasBloqueadas(datas) {
    if (!Array.isArray(datas)) return [];
    return [...new Set(
        datas
            .map(item => String(item || '').trim())
            .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item))
    )].sort();
}

function normalizarAgendaMedico(item, index = 0) {
    const idBase = slugifyId(item?.id || item?.nome || `medico-${index + 1}`) || `medico-${index + 1}`;
    const dias = Array.isArray(item?.diasSemana)
        ? [...new Set(item.diasSemana.map(Number).filter(d => d >= 0 && d <= 6))].sort((a, b) => a - b)
        : [1, 2, 3, 4, 5];
    const inicio = /^\d{2}:\d{2}$/.test(String(item?.inicio || '')) ? item.inicio : '07:00';
    const fim = /^\d{2}:\d{2}$/.test(String(item?.fim || '')) ? item.fim : '13:00';
    const intervaloMinutos = Math.max(5, Number(item?.intervaloMinutos) || 30);

    return {
        id: idBase,
        nome: String(item?.nome || '').trim() || `Medico ${index + 1}`,
        diasSemana: dias,
        inicio,
        fim,
        intervaloMinutos,
        datasBloqueadas: normalizarDatasBloqueadas(item?.datasBloqueadas)
    };
}

async function carregarMedicosAgenda() {
    const dados = await ipcRenderer.invoke('ler-medicos-agenda');
    try {
        const v = await ipcRenderer.invoke('data-get-version', 'medicos-agenda');
        dataVersions['medicos-agenda'] = Number(v?.version || 0);
    } catch (error) {
        console.warn('Falha ao obter versão de medicos-agenda:', error);
        dataVersions['medicos-agenda'] = 0;
    }
    if (Array.isArray(dados) && dados.length > 0) {
        medicosAgenda = dados.map((item, index) => normalizarAgendaMedico(item, index));
    } else {
        medicosAgenda = DEFAULT_MEDICOS_AGENDA.map((item, index) => normalizarAgendaMedico(item, index));
        await salvarMedicosAgenda();
    }
}

async function salvarMedicosAgenda() {
    const ok = await ipcRenderer.invoke('salvar-medicos-agenda', {
        data: medicosAgenda,
        expectedVersion: dataVersions['medicos-agenda'],
        detalhe: 'Atualizacao de agenda medica'
    });
    if (!ok) throw new Error('Falha ao salvar agenda médica (possível conflito).');
    const v = await ipcRenderer.invoke('data-get-version', 'medicos-agenda');
    dataVersions['medicos-agenda'] = Number(v?.version || dataVersions['medicos-agenda']);
}

function obterMedicoPorId(id) {
    return medicosAgenda.find(m => m.id === id) || null;
}

function obterPrimeiroMedico() {
    return medicosAgenda.length > 0 ? medicosAgenda[0] : null;
}

function normalizarAgendamento(item) {
    const medicoPorId = obterMedicoPorId(item.medicoId);
    const medicoPorNome = medicosAgenda.find(m => m.nome === item.nomeTecnico);
    const medicoFinal = medicoPorId || medicoPorNome || obterPrimeiroMedico();
    const legado = extrairCpfOuProntuarioLegado(item.documentoPaciente);
    const prontuarioPaciente = String(item.prontuarioPaciente || legado.prontuarioPaciente || '').trim().toUpperCase();
    const cpfPaciente = cpfSomenteDigitos(item.cpfPaciente || legado.cpfPaciente || '');

    return {
        ...item,
        cpfPaciente,
        prontuarioPaciente,
        documentoPaciente: prontuarioPaciente || String(item.documentoPaciente || '').trim(),
        medicoId: medicoFinal ? medicoFinal.id : '',
        nomeTecnico: medicoFinal ? medicoFinal.nome : (item.nomeTecnico || ''),
        modalidade: item.modalidade || 'Raiox',
        statusExame: item.statusExame || 'Agendado'
    };
}

async function carregarAgendamentos() {
    const dados = await ipcRenderer.invoke('ler-agendamentos');
    try {
        const v = await ipcRenderer.invoke('data-get-version', 'agendamentos');
        dataVersions.agendamentos = Number(v?.version || 0);
    } catch (error) {
        console.warn('Falha ao obter versão de agendamentos:', error);
        dataVersions.agendamentos = 0;
    }
    agendamentos = Array.isArray(dados) ? dados.map(normalizarAgendamento) : [];
    agendamentosFiltrados = [];
}

async function salvarAgendamentos() {
    const ok = await ipcRenderer.invoke('salvar-agendamentos', {
        data: agendamentos,
        expectedVersion: dataVersions.agendamentos,
        detalhe: 'Atualizacao de agendamentos'
    });
    if (!ok) throw new Error('Falha ao salvar agendamentos (possível conflito).');
    const v = await ipcRenderer.invoke('data-get-version', 'agendamentos');
    dataVersions.agendamentos = Number(v?.version || dataVersions.agendamentos);
}

async function carregarRegistros() {
    const dados = await ipcRenderer.invoke('ler-registros');
    try {
        const v = await ipcRenderer.invoke('data-get-version', 'registros');
        dataVersions.registros = Number(v?.version || 0);
    } catch (error) {
        console.warn('Falha ao obter versão de registros no agendamento:', error);
        dataVersions.registros = 0;
    }
    registros = Array.isArray(dados)
        ? dados.map(item => {
            const legado = extrairCpfOuProntuarioLegado(item.documentoPaciente || item.pacienteDocumento || '');
            const prontuarioPaciente = String(item.prontuarioPaciente || legado.prontuarioPaciente || '').trim().toUpperCase();
            const cpfPaciente = cpfSomenteDigitos(item.cpfPaciente || legado.cpfPaciente || '');
            return {
                ...item,
                cpfPaciente,
                prontuarioPaciente,
                documentoPaciente: prontuarioPaciente || String(item.documentoPaciente || item.pacienteDocumento || '').trim()
            };
        })
        : [];
}

async function salvarRegistros() {
    const ok = await ipcRenderer.invoke('salvar-registros', {
        data: registros,
        expectedVersion: dataVersions.registros,
        detalhe: 'Atualizacao de registros pelo agendamento'
    });
    if (!ok) throw new Error('Falha ao salvar registros (possível conflito).');
    const v = await ipcRenderer.invoke('data-get-version', 'registros');
    dataVersions.registros = Number(v?.version || dataVersions.registros);
}

async function carregarPacientes() {
    const dados = await ipcRenderer.invoke('ler-pacientes');
    try {
        const v = await ipcRenderer.invoke('data-get-version', 'pacientes');
        dataVersions.pacientes = Number(v?.version || 0);
    } catch (error) {
        console.warn('Falha ao obter versão de pacientes no agendamento:', error);
        dataVersions.pacientes = 0;
    }
    pacientes = Array.isArray(dados)
        ? dados.map(item => {
            const legado = extrairCpfOuProntuarioLegado(item.documentoPaciente);
            const prontuarioPaciente = String(item.prontuarioPaciente || legado.prontuarioPaciente || '').trim().toUpperCase();
            const cpfPaciente = cpfSomenteDigitos(item.cpfPaciente || legado.cpfPaciente || '');
            return {
                ...item,
                cpfPaciente,
                prontuarioPaciente,
                documentoPaciente: prontuarioPaciente || String(item.documentoPaciente || '').trim()
            };
        })
        : [];
}

async function salvarPacientes() {
    const ok = await ipcRenderer.invoke('salvar-pacientes', {
        data: pacientes,
        expectedVersion: dataVersions.pacientes,
        detalhe: 'Atualizacao de pacientes pelo agendamento'
    });
    if (!ok) throw new Error('Falha ao salvar pacientes (possível conflito).');
    const v = await ipcRenderer.invoke('data-get-version', 'pacientes');
    dataVersions.pacientes = Number(v?.version || dataVersions.pacientes);
}

function atualizarInfoAgendaMedico(medico) {
    const info = document.getElementById('agendaMedicoInfo');
    if (!info) return;

    if (!medico) {
        info.textContent = 'Nenhum médico cadastrado. Cadastre uma agenda médica.';
        return;
    }

    const dias = medico.diasSemana.map(d => DIAS_NOME[d]).join(', ');
    const bloqueios = normalizarDatasBloqueadas(medico.datasBloqueadas).length;
    info.textContent = `${medico.nome} atende: ${dias} | ${medico.inicio} às ${medico.fim} | ${medico.intervaloMinutos} min por paciente | ${bloqueios} dia(s) fechado(s)`;
}

function popularSelectMedicos(medicoIdSelecionado = '') {
    const select = document.getElementById('medicoId');
    if (!select) return;

    const atual = medicoIdSelecionado || select.value;
    select.innerHTML = '';

    medicosAgenda.forEach(medico => {
        const option = document.createElement('option');
        option.value = medico.id;
        option.textContent = medico.nome;
        select.appendChild(option);
    });

    if (medicosAgenda.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Sem médicos cadastrados';
        select.appendChild(option);
        select.value = '';
        return;
    }

    const valido = medicosAgenda.some(m => m.id === atual);
    select.value = valido ? atual : medicosAgenda[0].id;
}

function obterMedicoSelecionado() {
    const medicoId = document.getElementById('medicoId')?.value;
    return obterMedicoPorId(medicoId);
}

function conflitoDeAgenda({ medicoId, dataHora, ignorarAgendamentoId = null }) {
    return agendamentos.some(a =>
        a.id !== ignorarAgendamentoId &&
        a.medicoId === medicoId &&
        a.statusExame !== 'Cancelado' &&
        String(a.dataHora || '') === String(dataHora || '')
    );
}

function gerarHorariosDisponiveis(medico, dataIso, agendamentoEditandoId = null) {
    if (!medico || !dataIso) return [];
    if (normalizarDatasBloqueadas(medico.datasBloqueadas).includes(dataIso)) return [];

    const diaSemana = new Date(`${dataIso}T00:00:00`).getDay();
    if (!medico.diasSemana.includes(diaSemana)) return [];

    const inicio = parseHoraParaMinutos(medico.inicio);
    const fim = parseHoraParaMinutos(medico.fim);
    const slots = [];

    for (let minuto = inicio; minuto + medico.intervaloMinutos <= fim; minuto += medico.intervaloMinutos) {
        const hora = formatarMinutosParaHora(minuto);
        const ocupado = conflitoDeAgenda({
            medicoId: medico.id,
            dataHora: `${dataIso}T${hora}`,
            ignorarAgendamentoId: agendamentoEditandoId
        });
        if (!ocupado) slots.push(hora);
    }

    return slots;
}

function atualizarHorariosDisponiveisInterno(horaPreferida = '') {
    const medico = obterMedicoSelecionado();
    const dataAgendamento = document.getElementById('dataAgendamento').value;
    const selectHora = document.getElementById('horaAgendamento');

    atualizarInfoAgendaMedico(medico);
    selectHora.innerHTML = '<option value="" disabled selected>Selecione o horário</option>';

    if (!medico || !dataAgendamento) return;

    if (normalizarDatasBloqueadas(medico.datasBloqueadas).includes(dataAgendamento)) {
        const info = document.getElementById('agendaMedicoInfo');
        info.textContent += ` | Agenda fechada em ${formatarDataIsoParaBr(dataAgendamento)}.`;
        return;
    }

    const diaSemana = new Date(`${dataAgendamento}T00:00:00`).getDay();
    if (!medico.diasSemana.includes(diaSemana)) {
        const info = document.getElementById('agendaMedicoInfo');
        info.textContent += ' | Médico não atende nesse dia.';
        return;
    }

    const horarios = gerarHorariosDisponiveis(medico, dataAgendamento, selecionado?.id || null);
    if (horaPreferida && !horarios.includes(horaPreferida)) {
        horarios.push(horaPreferida);
        horarios.sort();
    }

    if (horarios.length === 0) {
        const option = document.createElement('option');
        option.disabled = true;
        option.textContent = 'Sem horário disponível';
        selectHora.appendChild(option);
        return;
    }

    horarios.forEach(hora => {
        const option = document.createElement('option');
        option.value = hora;
        option.textContent = hora;
        if (hora === horaPreferida) option.selected = true;
        selectHora.appendChild(option);
    });
}

function selecionarLinha(item) {
    selecionado = (selecionado && selecionado.id === item.id) ? null : item;
    renderTabela();
}

function atualizarBotoes() {
    const enabled = !!selecionado;
    document.getElementById('btnEditar').disabled = !enabled;
    document.getElementById('btnExcluir').disabled = !enabled;
    document.getElementById('btnHistorico').disabled = !enabled;
}

async function atualizarStatusAgendamentoInline(agendamentoId, novoStatus) {
    const idx = agendamentos.findIndex(item => idsIguais(item.id, agendamentoId));
    if (idx === -1) return;

    agendamentos[idx].statusExame = novoStatus;
    if (selecionado && idsIguais(selecionado.id, agendamentoId)) {
        selecionado.statusExame = novoStatus;
    }

    sincronizarAgendamentoComRegistro(agendamentos[idx]);
    await Promise.all([salvarAgendamentos(), salvarRegistros()]);
    renderTabela();
}

async function atualizarStatusRegistroInline(registroOrigemId, novoStatus) {
    const registroId = extrairIdRegistroOrigem(registroOrigemId);
    const idx = registros.findIndex(r => idsIguais(r.id, registroId));
    if (idx === -1) return;

    registros[idx].statusExame = novoStatus;
    if (selecionado && idsIguais(selecionado.id, registroOrigemId)) {
        selecionado.statusExame = novoStatus;
    }

    await salvarRegistros();
    renderTabela();
}

function renderTabela() {
    const tbody = document.getElementById('listaAgendamentos');
    tbody.innerHTML = '';
    const termo = obterTermoBusca();

    if (agendamentosFiltrados.length === 0) {
        tbody.innerHTML = `
            <tr class="empty-row">
                <td colspan="10" class="empty-state">${termo ? 'Nenhum agendamento encontrado para a busca.' : 'Nenhum agendamento ou registro disponível.'}</td>
            </tr>
        `;
        atualizarResumoTabela();
        atualizarBotoes();
        return;
    }

    agendamentosFiltrados.forEach(item => {
        const tr = document.createElement('tr');
        tr.dataset.id = String(item.id);
        const statusClasse = normalizarStatusParaClasse(item.statusExame || '');
        const statusAtual = item.statusExame || 'Agendado';
        const ehRegistro = item.fonte === 'registro';
        if (selecionado && selecionado.id === item.id) tr.classList.add('selected');
        tr.innerHTML = `
            <td>${item.nomePaciente || ''}</td>
            <td>${item.cpfPaciente || ''}</td>
            <td>${item.prontuarioPaciente || item.documentoPaciente || ''}</td>
            <td>${item.modalidade || ''}</td>
            <td>${item.exame || ''}</td>
            <td>${formatarData(item.dataHora) || ''}</td>
            <td>
                <select class="status-select-inline status-pill status-pill--${statusClasse}">
                    <option value="Agendado" ${statusAtual === 'Agendado' ? 'selected' : ''}>Agendado</option>
                    <option value="Realizado" ${statusAtual === 'Realizado' ? 'selected' : ''}>Realizado</option>
                    <option value="Cancelado" ${statusAtual === 'Cancelado' ? 'selected' : ''}>Cancelado</option>
                </select>
            </td>
            <td>${item.nomeTecnico || ''}</td>
            <td>${item.numeroAcesso || ''}</td>
            <td>
                <button type="button" class="print-btn-inline" title="Imprimir espelho do paciente">
                    <span aria-hidden="true">🖨️</span>
                </button>
            </td>
        `;
        tr.addEventListener('click', () => selecionarLinha(item));
        tr.addEventListener('dblclick', () => {
            selecionado = item;
            window.abrirModal('novo');
        });

        const statusSelect = tr.querySelector('.status-select-inline');
        if (statusSelect) {
            statusSelect.addEventListener('click', (event) => event.stopPropagation());
            statusSelect.addEventListener('dblclick', (event) => event.stopPropagation());
            statusSelect.addEventListener('change', async (event) => {
                event.stopPropagation();
                if (ehRegistro) {
                    await atualizarStatusRegistroInline(item.id, event.target.value);
                } else {
                    await atualizarStatusAgendamentoInline(item.id, event.target.value);
                }
            });
        }

        const printBtn = tr.querySelector('.print-btn-inline');
        if (printBtn) {
            printBtn.addEventListener('click', async (event) => {
                event.stopPropagation();
                await abrirModalSelecaoImpressao(item);
            });
            printBtn.addEventListener('dblclick', (event) => event.stopPropagation());
        }
        tbody.appendChild(tr);
    });

    atualizarResumoTabela();
    atualizarBotoes();
}

function coletarDadosPacienteParaImpressao(item) {
    const paciente = pacientes.find(p =>
        idsIguais(p.id, item.pacienteId) ||
        String(p.prontuarioPaciente || p.documentoPaciente || '').trim().toLowerCase() === String(item.prontuarioPaciente || item.documentoPaciente || '').trim().toLowerCase() ||
        cpfSomenteDigitos(p.cpfPaciente || '') === cpfSomenteDigitos(item.cpfPaciente || '')
    );

    return {
        nomePaciente: item.nomePaciente || paciente?.nomePaciente || '',
        cpfPaciente: item.cpfPaciente || paciente?.cpfPaciente || '',
        prontuarioPaciente: item.prontuarioPaciente || item.documentoPaciente || paciente?.prontuarioPaciente || paciente?.documentoPaciente || '',
        dataNascimentoPaciente: item.dataNascimentoPaciente || paciente?.dataNascimentoPaciente || '',
        telefonePaciente: item.telefonePaciente || paciente?.telefonePaciente || '',
        enderecoPaciente: item.enderecoPaciente || paciente?.enderecoPaciente || '',
        planoPaciente: item.planoPaciente || paciente?.planoPaciente || ''
    };
}

function obterExamesPendentesParaPaciente(item) {
    const prontuario = String(item.prontuarioPaciente || item.documentoPaciente || '').trim().toLowerCase();
    const cpf = cpfSomenteDigitos(item.cpfPaciente || '');
    const nomeNorm = removerAcentos(item.nomePaciente || '').toLowerCase().trim();

    const examesAgendamento = agendamentos
        .filter(a => {
            const mesmoProntuario = prontuario && String(a.prontuarioPaciente || a.documentoPaciente || '').trim().toLowerCase() === prontuario;
            const mesmoCpf = cpf && cpfSomenteDigitos(a.cpfPaciente || '') === cpf;
            const mesmoNomeSemDoc = !prontuario && !cpf && nomeNorm && removerAcentos(a.nomePaciente || '').toLowerCase().trim() === nomeNorm;
            const mesmoPaciente = mesmoProntuario || mesmoCpf || mesmoNomeSemDoc;
            const pendente = (a.statusExame || '') === 'Agendado';
            return mesmoPaciente && pendente;
        })
        .map(a => ({
            ...a,
            origem: 'Agendamento'
        }));

    const idsAgendamento = new Set(examesAgendamento.map(a => String(a.id)));
    const examesRegistro = registros
        .filter(r => {
            const mesmoProntuario = prontuario && String(r.prontuarioPaciente || r.documentoPaciente || '').trim().toLowerCase() === prontuario;
            const mesmoCpf = cpf && cpfSomenteDigitos(r.cpfPaciente || '') === cpf;
            const mesmoNomeSemDoc = !prontuario && !cpf && nomeNorm && removerAcentos(r.nomePaciente || '').toLowerCase().trim() === nomeNorm;
            const mesmoPaciente = mesmoProntuario || mesmoCpf || mesmoNomeSemDoc;
            const pendente = (r.statusExame || '') === 'Agendado';
            const jaVinculadoAoAgendamento = r.agendamentoId && idsAgendamento.has(String(r.agendamentoId));
            return mesmoPaciente && pendente && !jaVinculadoAoAgendamento;
        })
        .map(r => ({
            id: `reg-${r.id}`,
            origem: 'Registro',
            exame: r.observacoes,
            modalidade: r.modalidade,
            dataHora: r.dataHoraExame,
            nomeTecnico: r.nomeTecnico,
            numeroAcesso: r.numeroAcesso
        }));

    return [...examesAgendamento, ...examesRegistro]
        .sort((a, b) => new Date(a.dataHora || 0) - new Date(b.dataHora || 0));
}

async function abrirModalSelecaoImpressao(item) {
    const examesPendentes = obterExamesPendentesParaPaciente(item);
    if (examesPendentes.length === 0) {
        await abrirModalAviso({
            titulo: 'Sem exames pendentes',
            mensagem: 'Este paciente não possui exames pendentes para impressão.'
        });
        return;
    }

    const dadosPaciente = coletarDadosPacienteParaImpressao(item);
    contextoImpressao = {
        paciente: dadosPaciente,
        exames: examesPendentes
    };

    const info = document.getElementById('impressaoPacienteInfo');
    const lista = document.getElementById('impressaoListaExames');
    if (!info || !lista) return;

    info.textContent = `${dadosPaciente.nomePaciente || 'Paciente'} | CPF: ${dadosPaciente.cpfPaciente || '-'} | Prontuário: ${dadosPaciente.prontuarioPaciente || '-'}`;

    lista.innerHTML = examesPendentes.map((exame, idx) => `
        <label class="impressao-item">
            <input type="checkbox" class="impressao-exame-check" value="${escapeHtml(String(exame.id))}" ${idx === 0 ? 'checked' : ''}>
            <span>
                <strong>${escapeHtml(exame.exame || '')}</strong>
                <small>${escapeHtml(formatarData(exame.dataHora) || '')} | ${escapeHtml(exame.modalidade || '')} | Acesso: ${escapeHtml(exame.numeroAcesso || '')}</small>
                <small>Origem: ${escapeHtml(exame.origem || 'Agendamento')}</small>
            </span>
        </label>
    `).join('');

    fecharOutrosModais('modalImpressaoExames');
    abrirComAnimacao('modalImpressaoExames');
}

window.fecharModalImpressaoExames = function() {
    contextoImpressao = null;
    fecharComAnimacao('modalImpressaoExames', () => {
        const info = document.getElementById('impressaoPacienteInfo');
        const lista = document.getElementById('impressaoListaExames');
        if (info) info.textContent = '';
        if (lista) lista.innerHTML = '';
    });
};

window.imprimirEspelhoSelecionado = async function() {
    if (!contextoImpressao) return;
    const checks = Array.from(document.querySelectorAll('#impressaoListaExames .impressao-exame-check:checked'));
    if (checks.length === 0) {
        await abrirModalAviso({
            titulo: 'Seleção obrigatória',
            mensagem: 'Selecione ao menos um exame para imprimir.'
        });
        return;
    }

    const idsSelecionados = new Set(checks.map(c => String(c.value)));
    const examesSelecionados = contextoImpressao.exames.filter(exame => idsSelecionados.has(String(exame.id)));
    const paciente = contextoImpressao.paciente;
    const dataEmissao = new Date().toLocaleString('pt-BR');

    const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>Espelho de Exames</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
        h1 { margin: 0 0 12px; }
        .sub { margin: 0 0 18px; color: #555; font-size: 12px; }
        .toolbar { display: flex; gap: 10px; margin-bottom: 18px; }
        .toolbar button { border: 0; border-radius: 6px; padding: 10px 16px; font-size: 14px; cursor: pointer; }
        .toolbar .btn-print { background: #0d6efd; color: #fff; }
        .toolbar .btn-close { background: #6c757d; color: #fff; }
        .bloco { border: 1px solid #ccc; border-radius: 8px; padding: 12px; margin-bottom: 14px; }
        .linha { display: grid; grid-template-columns: 180px 1fr; gap: 8px; margin-bottom: 6px; }
        .label { font-weight: 700; }
        table { width: 100%; border-collapse: collapse; margin-top: 8px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 13px; }
        th { background: #f3f3f3; }
        @media print {
            body { margin: 10mm; }
            .toolbar { display: none; }
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <button type="button" class="btn-print" onclick="window.print()">Imprimir</button>
        <button type="button" class="btn-close" onclick="window.close()">Fechar</button>
    </div>
    <h1>Espelho de Exames</h1>
    <p class="sub">Emissão: ${escapeHtml(dataEmissao)}</p>
    <div class="bloco">
        <div class="linha"><div class="label">Paciente</div><div>${escapeHtml(paciente.nomePaciente || '-')}</div></div>
        <div class="linha"><div class="label">CPF</div><div>${escapeHtml(paciente.cpfPaciente || '-')}</div></div>
        <div class="linha"><div class="label">Prontuário</div><div>${escapeHtml(paciente.prontuarioPaciente || '-')}</div></div>
        <div class="linha"><div class="label">Nascimento</div><div>${escapeHtml(paciente.dataNascimentoPaciente || '-')}</div></div>
        <div class="linha"><div class="label">Telefone</div><div>${escapeHtml(paciente.telefonePaciente || '-')}</div></div>
        <div class="linha"><div class="label">Endereço</div><div>${escapeHtml(paciente.enderecoPaciente || '-')}</div></div>
        <div class="linha"><div class="label">Plano</div><div>${escapeHtml(paciente.planoPaciente || '-')}</div></div>
    </div>
    <div class="bloco">
        <div class="label">Exames Selecionados</div>
        <table>
            <thead>
                <tr>
                    <th>Exame</th>
                    <th>Modalidade</th>
                    <th>Data/Hora</th>
                    <th>Médico</th>
                    <th>Número de Acesso</th>
                </tr>
            </thead>
            <tbody>
                ${examesSelecionados.map(exame => `
                    <tr>
                        <td>${escapeHtml(exame.exame || '-')}</td>
                        <td>${escapeHtml(exame.modalidade || '-')}</td>
                        <td>${escapeHtml(formatarData(exame.dataHora) || '-')}</td>
                        <td>${escapeHtml(exame.nomeTecnico || '-')}</td>
                        <td>${escapeHtml(exame.numeroAcesso || '-')}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    </div>
</body>
</html>`;

    const janela = window.open('', '_blank', 'width=980,height=700');
    if (!janela) {
        await abrirModalAviso({
            titulo: 'Bloqueio de janela',
            mensagem: 'Não foi possível abrir a tela de impressão.'
        });
        return;
    }
    janela.document.open();
    janela.document.write(html);
    janela.document.close();
    janela.focus();

    window.fecharModalImpressaoExames();
};

function preencherPacientePorCpfOuProntuario() {
    const cpfBusca = cpfSomenteDigitos(document.getElementById('cpfPaciente').value);
    const prontuarioBusca = String(document.getElementById('prontuarioPaciente').value || '').trim().toLowerCase();
    if (!cpfBusca && !prontuarioBusca) return;

    const paciente = pacientes.find(p => {
        const cpfPaciente = cpfSomenteDigitos(p.cpfPaciente || '');
        const prontuarioPaciente = String(p.prontuarioPaciente || p.documentoPaciente || '').trim().toLowerCase();
        return (cpfBusca && cpfPaciente === cpfBusca) || (prontuarioBusca && prontuarioPaciente === prontuarioBusca);
    });
    if (!paciente) return;

    if (!document.getElementById('nomePaciente').value.trim()) {
        document.getElementById('nomePaciente').value = paciente.nomePaciente || '';
    }
    if (!document.getElementById('cpfPaciente').value.trim()) {
        document.getElementById('cpfPaciente').value = paciente.cpfPaciente || '';
    }
    if (!document.getElementById('prontuarioPaciente').value.trim()) {
        document.getElementById('prontuarioPaciente').value = paciente.prontuarioPaciente || paciente.documentoPaciente || '';
    }
    if (!document.getElementById('telefonePaciente').value.trim()) {
        document.getElementById('telefonePaciente').value = paciente.telefonePaciente || '';
    }
    if (!document.getElementById('enderecoPaciente').value.trim()) {
        document.getElementById('enderecoPaciente').value = paciente.enderecoPaciente || '';
    }
    if (!document.getElementById('planoPaciente').value.trim()) {
        document.getElementById('planoPaciente').value = paciente.planoPaciente || '';
    }
    if (!document.getElementById('dataNascimentoPaciente').value) {
        document.getElementById('dataNascimentoPaciente').value = paciente.dataNascimentoPaciente || '';
    }
}

function upsertPaciente(agendamento) {
    const prontuario = String(agendamento.prontuarioPaciente || '').trim().toUpperCase();
    const cpf = cpfSomenteDigitos(agendamento.cpfPaciente || '');
    if (!prontuario) return;

    let paciente = pacientes.find(p =>
        String(p.prontuarioPaciente || p.documentoPaciente || '').trim().toLowerCase() === prontuario.toLowerCase() ||
        (cpf && cpfSomenteDigitos(p.cpfPaciente || '') === cpf)
    );
    if (!paciente) {
        paciente = {
            id: Date.now().toString(),
            nomePaciente: agendamento.nomePaciente,
            cpfPaciente: cpf,
            prontuarioPaciente: prontuario,
            documentoPaciente: prontuario,
            telefonePaciente: agendamento.telefonePaciente || '',
            enderecoPaciente: agendamento.enderecoPaciente || '',
            planoPaciente: agendamento.planoPaciente || '',
            dataNascimentoPaciente: agendamento.dataNascimentoPaciente || ''
        };
        pacientes.push(paciente);
    } else {
        paciente.nomePaciente = agendamento.nomePaciente || paciente.nomePaciente;
        paciente.cpfPaciente = cpf || paciente.cpfPaciente || '';
        paciente.prontuarioPaciente = prontuario || paciente.prontuarioPaciente || paciente.documentoPaciente || '';
        paciente.documentoPaciente = paciente.prontuarioPaciente;
        paciente.telefonePaciente = agendamento.telefonePaciente || paciente.telefonePaciente || '';
        paciente.enderecoPaciente = agendamento.enderecoPaciente || paciente.enderecoPaciente || '';
        paciente.planoPaciente = agendamento.planoPaciente || paciente.planoPaciente || '';
        paciente.dataNascimentoPaciente = agendamento.dataNascimentoPaciente || paciente.dataNascimentoPaciente || '';
    }

    return paciente;
}

function sincronizarAgendamentoComRegistro(agendamento) {
    const indicesMesmaOrigem = registros
        .map((r, idx) => ({ idx, agendamentoId: r.agendamentoId }))
        .filter(item => idsIguais(item.agendamentoId, agendamento.id))
        .map(item => item.idx);
    const idxRegistro = indicesMesmaOrigem.length ? indicesMesmaOrigem[0] : -1;
    const registroExistente = idxRegistro !== -1 ? registros[idxRegistro] : null;

    if (agendamento.statusExame !== 'Realizado') {
        if (indicesMesmaOrigem.length) {
            for (let i = indicesMesmaOrigem.length - 1; i >= 0; i -= 1) {
                registros.splice(indicesMesmaOrigem[i], 1);
            }
        }
        return;
    }

    const baseRegistro = {
        id: registroExistente ? registroExistente.id : Date.now(),
        agendamentoId: agendamento.id,
        nomePaciente: agendamento.nomePaciente,
        documentoPaciente: agendamento.prontuarioPaciente || agendamento.documentoPaciente,
        modalidade: agendamento.modalidade,
        observacoes: agendamento.exame,
        numeroAcesso: agendamento.numeroAcesso,
        dataHoraExame: agendamento.dataHora,
        nomeTecnico: agendamento.nomeTecnico,
        statusExame: agendamento.statusExame,
        observacoesAdicionais: registroExistente ? (registroExistente.observacoesAdicionais || '') : ''
    };

    if (idxRegistro !== -1) {
        registros[idxRegistro] = baseRegistro;
        for (let i = indicesMesmaOrigem.length - 1; i >= 1; i -= 1) {
            registros.splice(indicesMesmaOrigem[i], 1);
        }
    } else {
        registros.unshift(baseRegistro);
    }
}

function sincronizarNomesMedicoNosAgendamentos() {
    agendamentos = agendamentos.map(item => {
        const medico = obterMedicoPorId(item.medicoId);
        if (!medico) return item;
        return {
            ...item,
            nomeTecnico: medico.nome
        };
    });

    const nomePorAgendamentoId = new Map(
        agendamentos.map(item => [String(item.id), item.nomeTecnico])
    );
    registros = registros.map(registro => {
        if (!nomePorAgendamentoId.has(String(registro.agendamentoId))) return registro;
        return {
            ...registro,
            nomeTecnico: nomePorAgendamentoId.get(String(registro.agendamentoId))
        };
    });

    window.filtrarAgendamentos();
}

function abrirComAnimacao(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => modal.classList.add('show'), 10);
}

function fecharComAnimacao(modalId, cleanup) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.remove('show');
    setTimeout(() => {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
        if (typeof cleanup === 'function') cleanup();
    }, 200);
}

function abrirModalConfirmacao({ titulo, mensagem, textoConfirmar = 'Confirmar' }) {
    const tituloEl = document.getElementById('confirmacaoTitulo');
    const mensagemEl = document.getElementById('confirmacaoMensagem');
    const btnConfirmar = document.getElementById('confirmacaoBtnConfirmar');

    if (!tituloEl || !mensagemEl || !btnConfirmar) {
        return Promise.resolve(false);
    }

    tituloEl.textContent = titulo || 'Confirmar ação';
    mensagemEl.textContent = mensagem || '';
    btnConfirmar.textContent = textoConfirmar;

    fecharOutrosModais('modalConfirmacao');
    abrirComAnimacao('modalConfirmacao');

    return new Promise(resolve => {
        resolverConfirmacao = resolve;
    });
}

window.responderConfirmacao = function(confirmou) {
    const finalizar = () => {
        if (typeof resolverConfirmacao === 'function') {
            resolverConfirmacao(Boolean(confirmou));
            resolverConfirmacao = null;
        }
    };

    fecharComAnimacao('modalConfirmacao', finalizar);
};

window.fecharModalConfirmacao = function() {
    window.responderConfirmacao(false);
};

function abrirModalAviso({ titulo, mensagem }) {
    const tituloEl = document.getElementById('avisoTitulo');
    const mensagemEl = document.getElementById('avisoMensagem');
    if (!tituloEl || !mensagemEl) return Promise.resolve();

    tituloEl.textContent = titulo || 'Aviso';
    mensagemEl.textContent = mensagem || '';
    fecharOutrosModais('modalAviso');
    abrirComAnimacao('modalAviso');

    return new Promise(resolve => {
        resolverAviso = resolve;
    });
}

window.fecharModalAviso = function() {
    const finalizar = () => {
        if (typeof resolverAviso === 'function') {
            resolverAviso();
            resolverAviso = null;
        }
    };
    fecharComAnimacao('modalAviso', finalizar);
};

window.atualizarHorariosDisponiveis = function() {
    atualizarHorariosDisponiveisInterno();
};

function fecharOutrosModais(modalIdAtual) {
    document.querySelectorAll('.modal').forEach(modal => {
        if (modal.id !== modalIdAtual) {
            modal.classList.remove('show');
            modal.style.display = 'none';
            modal.setAttribute('aria-hidden', 'true');
        }
    });
}

function habilitarCamposDoModalAgendamento() {
    document.querySelectorAll('#modalAgendamento input, #modalAgendamento select, #modalAgendamento button').forEach(el => {
        if (el.id === 'btnEditar' || el.id === 'btnExcluir' || el.id === 'btnHistorico') return;
        el.disabled = false;
        if ('readOnly' in el) {
            el.readOnly = false;
        }
    });
}

window.abrirModal = function(tipo) {
    const form = document.getElementById('formAgendamento');
    const title = document.getElementById('modalTitle');

    if (medicosAgenda.length === 0) {
        alert('Cadastre ao menos um médico em Agendas Médicas antes de agendar.');
        abrirModalAgendaMedico('novo');
        return;
    }

    if (tipo === 'novo') {
        const pacienteBase = obterPacienteBaseSelecionado();
        pacienteBaseNoNovo = pacienteBase;
        selecionado = null;
        form.reset();
        popularSelectMedicos(obterPrimeiroMedico()?.id || '');
        document.getElementById('dataAgendamento').value = obterDataHojeIso();
        document.getElementById('statusExame').value = 'Agendado';
        document.getElementById('modalidade').value = 'Raiox';
        document.getElementById('numeroAcesso').value = sugerirProximoNumeroAcesso();

        if (pacienteBase) {
            document.getElementById('nomePaciente').value = pacienteBase.nomePaciente;
            document.getElementById('cpfPaciente').value = pacienteBase.cpfPaciente;
            document.getElementById('prontuarioPaciente').value = pacienteBase.prontuarioPaciente;
            document.getElementById('telefonePaciente').value = pacienteBase.telefonePaciente;
            document.getElementById('dataNascimentoPaciente').value = pacienteBase.dataNascimentoPaciente;
            document.getElementById('enderecoPaciente').value = pacienteBase.enderecoPaciente;
            document.getElementById('planoPaciente').value = pacienteBase.planoPaciente;
        } else {
            document.getElementById('cpfPaciente').value = '';
            document.getElementById('prontuarioPaciente').value = sugerirProximoProntuario();
        }

        atualizarHorariosDisponiveisInterno();
        title.textContent = 'Novo Agendamento';
    } else if (tipo === 'editar') {
        pacienteBaseNoNovo = null;
        if (!selecionado) return;
        const [dataIso, horaIso] = String(selecionado.dataHora || '').split('T');
        const medicoPorNome = medicosAgenda.find(m => m.nome === selecionado.nomeTecnico);
        const paciente = pacientes.find(p =>
            (p.id && p.id === selecionado.pacienteId) ||
            (p.prontuarioPaciente || p.documentoPaciente || '').toLowerCase() === (selecionado.prontuarioPaciente || selecionado.documentoPaciente || '').toLowerCase() ||
            cpfSomenteDigitos(p.cpfPaciente || '') === cpfSomenteDigitos(selecionado.cpfPaciente || '')
        );

        document.getElementById('nomePaciente').value = selecionado.nomePaciente || '';
        document.getElementById('cpfPaciente').value = selecionado.cpfPaciente || paciente?.cpfPaciente || '';
        document.getElementById('prontuarioPaciente').value = selecionado.prontuarioPaciente || selecionado.documentoPaciente || paciente?.prontuarioPaciente || paciente?.documentoPaciente || '';
        document.getElementById('telefonePaciente').value = selecionado.telefonePaciente || paciente?.telefonePaciente || '';
        document.getElementById('dataNascimentoPaciente').value = selecionado.dataNascimentoPaciente || paciente?.dataNascimentoPaciente || '';
        document.getElementById('enderecoPaciente').value = selecionado.enderecoPaciente || paciente?.enderecoPaciente || '';
        document.getElementById('planoPaciente').value = selecionado.planoPaciente || paciente?.planoPaciente || '';
        popularSelectMedicos(selecionado.medicoId || medicoPorNome?.id || obterPrimeiroMedico()?.id || '');
        document.getElementById('modalidade').value = selecionado.modalidade || 'Raiox';
        document.getElementById('exame').value = selecionado.exame || '';
        document.getElementById('numeroAcesso').value = selecionado.numeroAcesso || '';
        document.getElementById('dataAgendamento').value = dataIso || obterDataHojeIso();
        document.getElementById('statusExame').value = selecionado.statusExame || 'Agendado';
        atualizarHorariosDisponiveisInterno((horaIso || '').slice(0, 5));
        title.textContent = selecionado.fonte === 'registro' ? 'Editar Registro (Origem Registros)' : 'Editar Agendamento';
    }

    fecharOutrosModais('modalAgendamento');
    habilitarCamposDoModalAgendamento();
    abrirComAnimacao('modalAgendamento');
    setTimeout(() => {
        const campoNome = document.getElementById('nomePaciente');
        campoNome.focus();
        campoNome.select();
    }, 30);
};

window.fecharModal = function() {
    pacienteBaseNoNovo = null;
    fecharComAnimacao('modalAgendamento');
};

window.salvarAgendamento = async function(event) {
    event.preventDefault();

    const editandoRegistroOrigem = selecionado && selecionado.fonte === 'registro';
    const medico = obterMedicoSelecionado();
    const dataAgendamento = document.getElementById('dataAgendamento').value;
    const horaAgendamento = document.getElementById('horaAgendamento').value;
    if (!medico || !dataAgendamento || !horaAgendamento) {
        alert('Selecione médico, data e horário válidos da agenda.');
        return;
    }

    if (!editandoRegistroOrigem) {
        const horariosValidos = gerarHorariosDisponiveis(medico, dataAgendamento, selecionado?.id || null);
        const editandoMesmoHorario = selecionado && String(selecionado.dataHora || '').startsWith(`${dataAgendamento}T${horaAgendamento}`);
        if (!horariosValidos.includes(horaAgendamento) && !editandoMesmoHorario) {
            alert('Horário inválido ou já ocupado para este médico.');
            return;
        }
    }

    const dataHoraNovo = `${dataAgendamento}T${horaAgendamento}`;
    if (!editandoRegistroOrigem) {
        const existeConflito = conflitoDeAgenda({
            medicoId: medico.id,
            dataHora: dataHoraNovo,
            ignorarAgendamentoId: selecionado?.id || null
        });
        if (existeConflito) {
            alert('Este médico já possui outro paciente agendado nesse dia e horário.');
            return;
        }
    }

    const novo = {
        id: selecionado ? selecionado.id : Date.now(),
        nomePaciente: document.getElementById('nomePaciente').value.trim(),
        cpfPaciente: cpfSomenteDigitos(document.getElementById('cpfPaciente').value),
        prontuarioPaciente: String(document.getElementById('prontuarioPaciente').value || '').trim().toUpperCase(),
        telefonePaciente: document.getElementById('telefonePaciente').value.trim(),
        dataNascimentoPaciente: document.getElementById('dataNascimentoPaciente').value || '',
        enderecoPaciente: document.getElementById('enderecoPaciente').value.trim(),
        planoPaciente: document.getElementById('planoPaciente').value.trim(),
        medicoId: medico.id,
        modalidade: document.getElementById('modalidade').value,
        exame: document.getElementById('exame').value.trim(),
        numeroAcesso: document.getElementById('numeroAcesso').value.trim(),
        dataHora: dataHoraNovo,
        nomeTecnico: medico.nome,
        statusExame: document.getElementById('statusExame').value
    };
    novo.documentoPaciente = novo.prontuarioPaciente;

    if (!selecionado && !pacienteBaseNoNovo) {
        if (existeCpfDuplicado(novo.cpfPaciente)) {
            await abrirModalAviso({
                titulo: 'Cadastro duplicado',
                mensagem: 'Já existe um paciente cadastrado com o mesmo CPF, prontuário ou número de acesso.'
            });
            return;
        }
        if (existeProntuarioDuplicado(novo.prontuarioPaciente)) {
            await abrirModalAviso({
                titulo: 'Cadastro duplicado',
                mensagem: 'Já existe um paciente cadastrado com o mesmo CPF, prontuário ou número de acesso.'
            });
            return;
        }
    }

    const acessoDuplicadoEmAgendamento = agendamentos.some(a =>
        !idsIguais(a.id, (selecionado?.id || null)) &&
        String(a.numeroAcesso || '').trim() === String(novo.numeroAcesso || '').trim()
    );
    const idRegistroEditando = editandoRegistroOrigem ? extrairIdRegistroOrigem(selecionado.id) : null;
    const acessoDuplicadoEmRegistro = registros.some(r =>
        !(editandoRegistroOrigem && idsIguais(r.id, idRegistroEditando)) &&
        !idsIguais(r.agendamentoId, (selecionado?.id || null)) &&
        String(r.numeroAcesso || '').trim() === String(novo.numeroAcesso || '').trim()
    );
    if (acessoDuplicadoEmAgendamento || acessoDuplicadoEmRegistro) {
        await abrirModalAviso({
            titulo: 'Cadastro duplicado',
            mensagem: 'Já existe um paciente cadastrado com o mesmo CPF, prontuário ou número de acesso.'
        });
        return;
    }

    const pacienteExistente = pacientes.find(p =>
        String(p.prontuarioPaciente || p.documentoPaciente || '').trim().toLowerCase() === String(novo.prontuarioPaciente || '').trim().toLowerCase() ||
        (novo.cpfPaciente && cpfSomenteDigitos(p.cpfPaciente || '') === novo.cpfPaciente)
    );
    const criandoNovoPaciente = !selecionado && !pacienteExistente;

    if (criandoNovoPaciente) {
        novo.prontuarioPaciente = consumirProximoProntuario();
        novo.documentoPaciente = novo.prontuarioPaciente;
        document.getElementById('prontuarioPaciente').value = novo.prontuarioPaciente;
    }

    if (!selecionado) {
        novo.numeroAcesso = consumirProximoNumeroAcesso();
        document.getElementById('numeroAcesso').value = novo.numeroAcesso;
    }

    if (agendamentos.some(a =>
        a.id !== (selecionado?.id || null) &&
        String(a.numeroAcesso || '').trim() === String(novo.numeroAcesso || '').trim()
    )) {
        novo.numeroAcesso = consumirProximoNumeroAcesso(selecionado?.id || null);
        document.getElementById('numeroAcesso').value = novo.numeroAcesso;
    }

    const pacienteAtualizado = upsertPaciente(novo);
    novo.pacienteId = pacienteAtualizado?.id || novo.pacienteId || '';

    if (editandoRegistroOrigem) {
        const registroId = extrairIdRegistroOrigem(selecionado.id);
        const idxReg = registros.findIndex(r => idsIguais(r.id, registroId));
        if (idxReg !== -1) {
            registros[idxReg] = {
                ...registros[idxReg],
                nomePaciente: novo.nomePaciente,
                cpfPaciente: novo.cpfPaciente,
                prontuarioPaciente: novo.prontuarioPaciente,
                documentoPaciente: novo.prontuarioPaciente || novo.documentoPaciente,
                pacienteId: novo.pacienteId,
                modalidade: novo.modalidade,
                observacoes: novo.exame,
                numeroAcesso: novo.numeroAcesso,
                dataHoraExame: novo.dataHora,
                nomeTecnico: novo.nomeTecnico,
                statusExame: novo.statusExame
            };
        }
    } else if (selecionado) {
        const idx = agendamentos.findIndex(x => x.id === selecionado.id);
        if (idx !== -1) agendamentos[idx] = novo;
    } else {
        agendamentos.unshift(novo);
    }

    if (!editandoRegistroOrigem) {
        sincronizarAgendamentoComRegistro(novo);
    }
    await Promise.all([salvarAgendamentos(), salvarPacientes(), salvarRegistros(), salvarConfigSistema()]);
    await carregarRegistros();

    selecionado = null;
    pacienteBaseNoNovo = null;
    window.filtrarAgendamentos();
    fecharModal();
};

window.excluirAgendamento = async function() {
    if (!selecionado) return;
    const registroOrigem = selecionado.fonte === 'registro';
    const confirmou = await abrirModalConfirmacao({
        titulo: registroOrigem ? 'Excluir registro' : 'Excluir agendamento',
        mensagem: registroOrigem
            ? 'Deseja excluir o registro selecionado (origem Registros)?'
            : 'Deseja excluir o agendamento selecionado?',
        textoConfirmar: 'Excluir'
    });
    if (!confirmou) return;

    if (registroOrigem) {
        const registroId = extrairIdRegistroOrigem(selecionado.id);
        registros = registros.filter(r => !idsIguais(r.id, registroId));
    } else {
        agendamentos = agendamentos.filter(x => !idsIguais(x.id, selecionado.id));
        registros = registros.filter(r => !idsIguais(r.agendamentoId, selecionado.id));
    }
    selecionado = null;
    window.filtrarAgendamentos();

    await Promise.all([salvarAgendamentos(), salvarRegistros()]);
};

function normalizarRegistroParaTabelaAgendamento(registro) {
    return {
        id: `reg-${registro.id}`,
        fonte: 'registro',
        nomePaciente: registro.nomePaciente || '',
        cpfPaciente: registro.cpfPaciente || '',
        prontuarioPaciente: registro.prontuarioPaciente || registro.documentoPaciente || '',
        documentoPaciente: registro.prontuarioPaciente || registro.documentoPaciente || '',
        modalidade: registro.modalidade || '',
        exame: registro.observacoes || '',
        dataHora: registro.dataHoraExame || '',
        statusExame: registro.statusExame || 'Agendado',
        nomeTecnico: registro.nomeTecnico || '',
        numeroAcesso: registro.numeroAcesso || '',
        pacienteId: registro.pacienteId || ''
    };
}

function obterItensTabelaAgendamento(termo = '') {
    const termoNormalizado = String(termo || '').trim();
    const filtrarItem = (item) => {
        if (!termoNormalizado) return true;
        const nome = removerAcentos(item.nomePaciente || '').toLowerCase();
        const cpf = removerAcentos(item.cpfPaciente || '').toLowerCase();
        const prontuario = removerAcentos(item.prontuarioPaciente || item.documentoPaciente || '').toLowerCase();
        return nome.includes(termoNormalizado) || cpf.includes(termoNormalizado) || prontuario.includes(termoNormalizado);
    };

    const encontradosAgendamento = agendamentos.filter(filtrarItem);
    const idsAgendamentosEncontrados = new Set(encontradosAgendamento.map(a => String(a.id)));
    const encontradosRegistro = registros
        .filter(filtrarItem)
        .filter(r => {
            if (r.agendamentoId && idsAgendamentosEncontrados.has(String(r.agendamentoId))) return false;
            return !(r.agendamentoId && agendamentos.some(a => idsIguais(a.id, r.agendamentoId)));
        })
        .map(normalizarRegistroParaTabelaAgendamento);

    return [...encontradosAgendamento, ...encontradosRegistro].sort((a, b) => {
        const da = new Date(a.dataHora || 0).getTime();
        const db = new Date(b.dataHora || 0).getTime();
        return db - da;
    });
}

window.filtrarAgendamentos = function() {
    const termo = obterTermoBusca();
    agendamentosFiltrados = obterItensTabelaAgendamento(termo);

    if (selecionado && !agendamentosFiltrados.some(item => item.id === selecionado.id)) {
        selecionado = null;
        pacienteBaseNoNovo = null;
    }

    renderTabela();
};

function obterLimitesPeriodo(periodo, dataReferenciaIso) {
    const dataBase = new Date(`${dataReferenciaIso}T00:00:00`);
    if (Number.isNaN(dataBase.getTime())) {
        const hoje = new Date();
        return obterLimitesPeriodo(periodo, obterDataLocalIso(hoje));
    }

    let inicio = new Date(dataBase);
    let fim = new Date(dataBase);

    if (periodo === 'dia') {
        fim.setHours(23, 59, 59, 999);
        return { inicio, fim };
    }

    if (periodo === 'semana') {
        const diaSemana = dataBase.getDay();
        inicio.setDate(dataBase.getDate() - diaSemana);
        fim = new Date(inicio);
        fim.setDate(inicio.getDate() + 6);
        fim.setHours(23, 59, 59, 999);
        return { inicio, fim };
    }

    if (periodo === 'mes') {
        inicio = new Date(dataBase.getFullYear(), dataBase.getMonth(), 1);
        fim = new Date(dataBase.getFullYear(), dataBase.getMonth() + 1, 0, 23, 59, 59, 999);
        return { inicio, fim };
    }

    inicio = new Date(dataBase.getFullYear(), 0, 1);
    fim = new Date(dataBase.getFullYear(), 11, 31, 23, 59, 59, 999);
    return { inicio, fim };
}

function filtrarAgendamentosPorPeriodo(periodo, dataReferenciaIso) {
    const { inicio, fim } = obterLimitesPeriodo(periodo, dataReferenciaIso);
    return agendamentos.filter(item => {
        const data = new Date(item.dataHora || '');
        if (Number.isNaN(data.getTime())) return false;
        return data >= inicio && data <= fim;
    });
}

function gerarSeriePerformance(periodo, dataReferenciaIso, itensPeriodo) {
    const base = new Date(`${dataReferenciaIso}T00:00:00`);
    const mapa = new Map();
    const formatar2 = (n) => String(n).padStart(2, '0');

    if (periodo === 'dia') {
        for (let h = 0; h < 24; h += 1) mapa.set(h, 0);
        itensPeriodo.forEach(item => {
            const data = new Date(item.dataHora || '');
            if (Number.isNaN(data.getTime())) return;
            mapa.set(data.getHours(), (mapa.get(data.getHours()) || 0) + 1);
        });
        return Array.from(mapa.entries()).map(([hora, valor]) => ({ label: `${formatar2(hora)}h`, valor }));
    }

    if (periodo === 'semana') {
        const inicioSemana = new Date(base);
        inicioSemana.setDate(base.getDate() - base.getDay());
        const nomes = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
        for (let i = 0; i < 7; i += 1) mapa.set(i, 0);
        itensPeriodo.forEach(item => {
            const data = new Date(item.dataHora || '');
            if (Number.isNaN(data.getTime())) return;
            const idx = Math.floor((new Date(data.getFullYear(), data.getMonth(), data.getDate()) - new Date(inicioSemana.getFullYear(), inicioSemana.getMonth(), inicioSemana.getDate())) / 86400000);
            if (idx >= 0 && idx < 7) mapa.set(idx, (mapa.get(idx) || 0) + 1);
        });
        return Array.from(mapa.entries()).map(([idx, valor]) => ({ label: nomes[idx], valor }));
    }

    if (periodo === 'mes') {
        const diasNoMes = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
        for (let d = 1; d <= diasNoMes; d += 1) mapa.set(d, 0);
        itensPeriodo.forEach(item => {
            const data = new Date(item.dataHora || '');
            if (Number.isNaN(data.getTime())) return;
            mapa.set(data.getDate(), (mapa.get(data.getDate()) || 0) + 1);
        });
        return Array.from(mapa.entries()).map(([dia, valor]) => ({ label: String(dia), valor }));
    }

    const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    for (let m = 0; m < 12; m += 1) mapa.set(m, 0);
    itensPeriodo.forEach(item => {
        const data = new Date(item.dataHora || '');
        if (Number.isNaN(data.getTime())) return;
        mapa.set(data.getMonth(), (mapa.get(data.getMonth()) || 0) + 1);
    });
    return Array.from(mapa.entries()).map(([mes, valor]) => ({ label: meses[mes], valor }));
}

function renderGraficoStatus(itensPeriodo) {
    const el = document.getElementById('perfStatusChart');
    if (!el) return;

    const total = itensPeriodo.length || 1;
    const status = [
        { nome: 'Agendado', valor: itensPeriodo.filter(i => i.statusExame === 'Agendado').length, cls: 'agendado' },
        { nome: 'Realizado', valor: itensPeriodo.filter(i => i.statusExame === 'Realizado').length, cls: 'realizado' },
        { nome: 'Cancelado', valor: itensPeriodo.filter(i => i.statusExame === 'Cancelado').length, cls: 'cancelado' }
    ];

    el.innerHTML = `
        <h3>Distribuição por status</h3>
        ${status.map(item => {
            const percent = Math.round((item.valor / total) * 100);
            return `
                <div class="status-row">
                    <span>${item.nome}</span>
                    <div class="status-bar"><div class="status-bar-fill status-bar-fill--${item.cls}" style="width:${percent}%"></div></div>
                    <strong>${percent}%</strong>
                </div>
            `;
        }).join('')}
    `;
}

function renderGraficoTendencia(periodo, dataReferenciaIso, itensPeriodo) {
    const el = document.getElementById('perfTrendChart');
    if (!el) return;

    const serie = gerarSeriePerformance(periodo, dataReferenciaIso, itensPeriodo);
    const max = Math.max(1, ...serie.map(p => p.valor));
    const titulo = periodo === 'dia' ? 'Tendência por hora' :
        (periodo === 'semana' ? 'Tendência por dia da semana' :
            (periodo === 'mes' ? 'Tendência diária do mês' : 'Tendência mensal do ano'));

    el.innerHTML = `
        <h3>${titulo}</h3>
        <div class="trend-grid">
            ${serie.map(ponto => {
                const largura = Math.max(2, Math.round((ponto.valor / max) * 100));
                return `
                    <div class="trend-item">
                        <span class="trend-label">${ponto.label}</span>
                        <div class="trend-bar"><div class="trend-bar-fill" style="width:${largura}%"></div></div>
                        <span class="trend-value">${ponto.valor}</span>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

window.renderPerformance = function() {
    const periodo = document.getElementById('perfPeriodo')?.value || 'dia';
    const dataReferenciaIso = document.getElementById('perfData')?.value || obterDataHojeIso();
    const resumo = document.getElementById('perfResumo');
    if (!resumo) return;

    const itensPeriodo = filtrarAgendamentosPorPeriodo(periodo, dataReferenciaIso);
    const total = itensPeriodo.length;
    const realizados = itensPeriodo.filter(i => i.statusExame === 'Realizado').length;
    const cancelados = itensPeriodo.filter(i => i.statusExame === 'Cancelado').length;
    const taxaRealizacao = total ? Math.round((realizados / total) * 100) : 0;
    const taxaCancelamento = total ? Math.round((cancelados / total) * 100) : 0;
    const periodoTexto = periodo === 'dia' ? 'Diário' :
        (periodo === 'semana' ? 'Semanal' :
            (periodo === 'mes' ? 'Mensal' : 'Anual'));
    const diasCobertos = periodo === 'dia' ? 1 : (periodo === 'semana' ? 7 : (periodo === 'mes' ? 30 : 365));
    const mediaDiaria = total ? (total / diasCobertos).toFixed(1) : '0.0';

    atualizarMetricasPainel(itensPeriodo);
    resumo.innerHTML = `
        <strong>Visão ${periodoTexto}</strong> | Referência: ${formatarDataIsoParaBr(dataReferenciaIso)}<br>
        Taxa de realização: <strong>${taxaRealizacao}%</strong> | Taxa de cancelamento: <strong>${taxaCancelamento}%</strong> | Média diária: <strong>${mediaDiaria}</strong>
    `;

    renderGraficoStatus(itensPeriodo);
    renderGraficoTendencia(periodo, dataReferenciaIso, itensPeriodo);
};

window.abrirModalPerformance = function() {
    const inputData = document.getElementById('perfData');
    if (inputData) inputData.value = obterDataHojeIso();
    fecharOutrosModais('modalPerformance');
    abrirComAnimacao('modalPerformance');
    window.renderPerformance();
};

window.fecharModalPerformance = function() {
    fecharComAnimacao('modalPerformance', () => {
        const resumo = document.getElementById('perfResumo');
        const statusChart = document.getElementById('perfStatusChart');
        const trendChart = document.getElementById('perfTrendChart');
        if (resumo) resumo.innerHTML = '';
        if (statusChart) statusChart.innerHTML = '';
        if (trendChart) trendChart.innerHTML = '';
    });
};

function obterStatusDisponibilidadeDia(medico, dataIso) {
    const diaSemana = new Date(`${dataIso}T00:00:00`).getDay();
    const dataBloqueada = normalizarDatasBloqueadas(medico.datasBloqueadas).includes(dataIso);

    if (dataBloqueada) {
        return {
            dataIso,
            situacao: 'fechado',
            descricao: 'Agenda fechada',
            livres: [],
            ocupados: []
        };
    }

    if (!medico.diasSemana.includes(diaSemana)) {
        return {
            dataIso,
            situacao: 'sem-atendimento',
            descricao: 'Sem atendimento',
            livres: [],
            ocupados: []
        };
    }

    const inicio = parseHoraParaMinutos(medico.inicio);
    const fim = parseHoraParaMinutos(medico.fim);
    const livres = [];
    const ocupados = [];

    for (let minuto = inicio; minuto + medico.intervaloMinutos <= fim; minuto += medico.intervaloMinutos) {
        const hora = formatarMinutosParaHora(minuto);
        const ocupado = conflitoDeAgenda({
            medicoId: medico.id,
            dataHora: `${dataIso}T${hora}`,
            ignorarAgendamentoId: null
        });
        if (ocupado) ocupados.push(hora);
        else livres.push(hora);
    }

    return {
        dataIso,
        situacao: 'atendimento',
        descricao: 'Atendimento ativo',
        livres,
        ocupados
    };
}

window.renderDisponibilidadeMedico = function() {
    const medicoId = document.getElementById('dispMedico')?.value;
    const periodo = document.getElementById('dispPeriodo')?.value || 'dia';
    const dataReferenciaIso = document.getElementById('dispData')?.value || obterDataHojeIso();
    const resumo = document.getElementById('resumoDisponibilidade');
    const lista = document.getElementById('listaDisponibilidade');
    if (!resumo || !lista) return;

    const medico = obterMedicoPorId(medicoId);
    if (!medico) {
        resumo.innerHTML = '<strong>Nenhum médico selecionado.</strong>';
        lista.innerHTML = '<p class="disponibilidade-vazio">Selecione um médico para visualizar a agenda.</p>';
        return;
    }

    const datas = obterDatasPeriodo(periodo, dataReferenciaIso);
    const itens = datas.map(dataIso => obterStatusDisponibilidadeDia(medico, dataIso));
    const periodoTexto = periodo === 'dia' ? 'Dia' : (periodo === 'semana' ? 'Semana' : 'Mês');

    const totalLivres = itens.reduce((acc, item) => acc + item.livres.length, 0);
    const totalOcupados = itens.reduce((acc, item) => acc + item.ocupados.length, 0);

    resumo.innerHTML = `
        <strong>${medico.nome}</strong> | Período: ${periodoTexto} | Referência: ${formatarDataIsoParaBr(dataReferenciaIso)}<br>
        Livres: <strong>${totalLivres}</strong> | Ocupados: <strong>${totalOcupados}</strong> | Dias analisados: <strong>${itens.length}</strong>
    `;

    if (itens.length === 0) {
        lista.innerHTML = '<p class="disponibilidade-vazio">Nenhuma data disponível para o período selecionado.</p>';
        return;
    }

    lista.innerHTML = itens.map(item => {
        const dataExibicao = new Date(`${item.dataIso}T00:00:00`).toLocaleDateString('pt-BR', {
            weekday: 'short',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });

        const chipsLivres = item.livres.map(hora => `<span class="horario-chip horario-chip--livre">${hora}</span>`).join('');
        const chipsOcupados = item.ocupados.map(hora => `<span class="horario-chip horario-chip--ocupado">${hora}</span>`).join('');
        const conteudoHorarios = (chipsLivres || chipsOcupados) ? `
            <div class="disponibilidade-horarios">
                ${chipsLivres}${chipsOcupados}
            </div>
        ` : '<p class="disponibilidade-vazio">Sem horários para esta data.</p>';

        return `
            <article class="disponibilidade-item">
                <div class="disponibilidade-item-head">
                    <strong>${dataExibicao}</strong>
                    <span class="disponibilidade-meta">${item.descricao}</span>
                </div>
                <div class="disponibilidade-tags">
                    <span class="disponibilidade-tag disponibilidade-tag--livre">Livres: ${item.livres.length}</span>
                    <span class="disponibilidade-tag disponibilidade-tag--ocupado">Ocupados: ${item.ocupados.length}</span>
                </div>
                ${conteudoHorarios}
            </article>
        `;
    }).join('');
};

window.abrirModalDisponibilidade = function() {
    const selectMedico = document.getElementById('dispMedico');
    const inputData = document.getElementById('dispData');
    if (!selectMedico || !inputData) return;

    selectMedico.innerHTML = medicosAgenda.map(medico => (
        `<option value="${medico.id}">${medico.nome}</option>`
    )).join('');

    if (medicosAgenda.length === 0) {
        selectMedico.innerHTML = '<option value="">Sem médicos cadastrados</option>';
    }

    inputData.value = obterDataHojeIso();
    fecharOutrosModais('modalDisponibilidade');
    abrirComAnimacao('modalDisponibilidade');
    window.renderDisponibilidadeMedico();
};

window.fecharModalDisponibilidade = function() {
    fecharComAnimacao('modalDisponibilidade', () => {
        const resumo = document.getElementById('resumoDisponibilidade');
        const lista = document.getElementById('listaDisponibilidade');
        if (resumo) resumo.innerHTML = '';
        if (lista) lista.innerHTML = '';
    });
};

async function renderHistorico(documentoPaciente, nomePaciente = '') {
    const info = document.getElementById('historicoPacienteInfo');
    const lista = document.getElementById('historicoPacienteLista');
    const result = await ipcRenderer.invoke('patient-timeline', {
        documento: documentoPaciente,
        nome: nomePaciente
    });
    if (!result?.ok) {
        info.textContent = result?.message || 'Erro ao consultar histórico.';
        lista.innerHTML = '';
        abrirComAnimacao('modalHistoricoPaciente');
        return;
    }

    const historico = Array.isArray(result.timeline) ? result.timeline : [];
    const nomeExibicao = result.nomeExibicao || nomePaciente || 'Paciente';
    const documentoExibicao = result.documentoExibicao || documentoPaciente || '-';
    info.textContent = `${nomeExibicao} - ${documentoExibicao} | ${historico.length} item(s)`;

    if (historico.length === 0) {
        lista.innerHTML = '<p>Nenhum histórico encontrado para este paciente.</p>';
    } else {
        const linhas = historico.map(h => `
            <tr>
                <td>${h.origem}</td>
                <td>${formatarData(h.data)}</td>
                <td>${h.status || ''}</td>
                <td>${h.modalidade || ''}</td>
                <td>${h.exame || ''}</td>
                <td>${h.tecnico || ''}</td>
                <td>${h.acesso || ''}</td>
            </tr>
        `).join('');

        lista.innerHTML = `
            <table class="historico-table">
                <thead>
                    <tr>
                        <th>Origem</th>
                        <th>Data/Hora</th>
                        <th>Status</th>
                        <th>Modalidade</th>
                        <th>Exame</th>
                        <th>Técnico</th>
                        <th>Acesso</th>
                    </tr>
                </thead>
                <tbody>${linhas}</tbody>
            </table>
        `;
    }

    abrirComAnimacao('modalHistoricoPaciente');
}

window.abrirHistoricoPaciente = async function() {
    if (!selecionado) {
        alert('Selecione um agendamento para visualizar o histórico do paciente.');
        return;
    }
    await renderHistorico(selecionado.prontuarioPaciente || selecionado.documentoPaciente || selecionado.cpfPaciente || '', selecionado.nomePaciente);
};

window.abrirHistoricoPorCadastro = async function() {
    const documento = (document.getElementById('prontuarioPaciente').value || document.getElementById('cpfPaciente').value || '').trim();
    const nome = document.getElementById('nomePaciente').value.trim();
    if (!documento && !nome) {
        alert('Informe CPF, prontuário ou nome para consultar o histórico.');
        return;
    }
    await renderHistorico(documento, nome);
};

window.fecharModalHistorico = function() {
    fecharComAnimacao('modalHistoricoPaciente', () => {
        document.getElementById('historicoPacienteInfo').textContent = '';
        document.getElementById('historicoPacienteLista').innerHTML = '';
    });
};

function formatarResumoAgenda(medico) {
    const dias = medico.diasSemana.map(d => DIAS_NOME[d]).join(', ');
    const qtdBloqueio = normalizarDatasBloqueadas(medico.datasBloqueadas).length;
    return `${dias} | ${medico.inicio} às ${medico.fim} | ${medico.intervaloMinutos} min | ${qtdBloqueio} fechado(s)`;
}

function setEstadoBotoesAgendaMedico() {
    const btnExcluir = document.getElementById('btnExcluirAgendaMedico');
    if (btnExcluir) btnExcluir.disabled = !selecionadoAgendaMedico;
}

function renderListaMedicosAgenda() {
    const container = document.getElementById('listaMedicosAgenda');
    if (!container) return;

    if (medicosAgenda.length === 0) {
        container.innerHTML = '<p>Nenhum médico cadastrado.</p>';
        setEstadoBotoesAgendaMedico();
        return;
    }

    container.innerHTML = medicosAgenda.map(medico => {
        const selectedClass = selecionadoAgendaMedico && selecionadoAgendaMedico.id === medico.id ? 'selected' : '';
        return `
            <div class="agenda-item ${selectedClass}" data-medico-id="${medico.id}">
                <div class="agenda-item-titulo">${medico.nome}</div>
                <div class="agenda-item-sub">${formatarResumoAgenda(medico)}</div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.agenda-item').forEach(itemEl => {
        itemEl.addEventListener('click', () => {
            const id = itemEl.getAttribute('data-medico-id');
            selecionarAgendaMedico(id);
        });
    });

    setEstadoBotoesAgendaMedico();
}

function limparFormAgendaMedico() {
    const form = document.getElementById('formAgendaMedico');
    form.reset();

    document.getElementById('agendaMedicoId').value = '';
    document.getElementById('agendaMedicoIntervalo').value = '30';
    document.getElementById('agendaMedicoInicio').value = '07:00';
    document.getElementById('agendaMedicoFim').value = '13:00';
    document.getElementById('agendaDataBloqueio').value = '';

    document.querySelectorAll('#formAgendaMedico .dias-semana-group input[type="checkbox"]').forEach(checkbox => {
        checkbox.checked = ['1', '2', '3', '4', '5'].includes(checkbox.value);
    });

    datasBloqueadasAgendaMedico = [];
    renderDatasBloqueadasAgendaMedico();
    selecionadoAgendaMedico = null;
    setEstadoBotoesAgendaMedico();
    renderListaMedicosAgenda();

    const inputNome = document.getElementById('agendaMedicoNome');
    inputNome.readOnly = false;
    setTimeout(() => inputNome.focus(), 20);
}

function preencherFormAgendaMedico(medico) {
    if (!medico) return;

    document.getElementById('agendaMedicoId').value = medico.id;
    document.getElementById('agendaMedicoNome').value = medico.nome;
    document.getElementById('agendaMedicoInicio').value = medico.inicio;
    document.getElementById('agendaMedicoFim').value = medico.fim;
    document.getElementById('agendaMedicoIntervalo').value = String(medico.intervaloMinutos);
    document.getElementById('agendaDataBloqueio').value = '';

    document.querySelectorAll('#formAgendaMedico .dias-semana-group input[type="checkbox"]').forEach(checkbox => {
        checkbox.checked = medico.diasSemana.includes(Number(checkbox.value));
    });

    datasBloqueadasAgendaMedico = normalizarDatasBloqueadas(medico.datasBloqueadas);
    renderDatasBloqueadasAgendaMedico();
    setEstadoBotoesAgendaMedico();
}

function renderDatasBloqueadasAgendaMedico() {
    const container = document.getElementById('listaDatasBloqueadasMedico');
    if (!container) return;

    if (datasBloqueadasAgendaMedico.length === 0) {
        container.innerHTML = '<p>Nenhum dia fechado cadastrado.</p>';
        return;
    }

    container.innerHTML = datasBloqueadasAgendaMedico.map(dataIso => `
        <div class="data-bloqueada-item">
            <span>${formatarDataIsoParaBr(dataIso)}</span>
            <button type="button" class="btn-remover-data" onclick="removerDataBloqueioMedico('${dataIso}')">Remover</button>
        </div>
    `).join('');
}

window.adicionarDataBloqueioMedico = function() {
    const input = document.getElementById('agendaDataBloqueio');
    const data = String(input.value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
        alert('Selecione uma data válida para fechar a agenda.');
        return;
    }

    if (datasBloqueadasAgendaMedico.includes(data)) {
        alert('Este dia já está fechado para este médico.');
        return;
    }

    datasBloqueadasAgendaMedico.push(data);
    datasBloqueadasAgendaMedico = normalizarDatasBloqueadas(datasBloqueadasAgendaMedico);
    input.value = '';
    renderDatasBloqueadasAgendaMedico();
};

window.removerDataBloqueioMedico = function(dataIso) {
    datasBloqueadasAgendaMedico = datasBloqueadasAgendaMedico.filter(item => item !== dataIso);
    renderDatasBloqueadasAgendaMedico();
};

function selecionarAgendaMedico(id) {
    selecionadoAgendaMedico = obterMedicoPorId(id);
    preencherFormAgendaMedico(selecionadoAgendaMedico);
    renderListaMedicosAgenda();
}

function validarAgendaMedico({ nome, diasSemana, inicio, fim, intervaloMinutos }) {
    if (!nome) {
        alert('Informe o nome do médico.');
        return false;
    }

    if (!Array.isArray(diasSemana) || diasSemana.length === 0) {
        alert('Selecione ao menos um dia de atendimento.');
        return false;
    }

    const inicioMin = parseHoraParaMinutos(inicio);
    const fimMin = parseHoraParaMinutos(fim);
    if (!Number.isFinite(inicioMin) || !Number.isFinite(fimMin) || inicioMin >= fimMin) {
        alert('Horário de início deve ser menor que o horário de fim.');
        return false;
    }

    if (!Number.isFinite(intervaloMinutos) || intervaloMinutos <= 0) {
        alert('Intervalo deve ser maior que zero.');
        return false;
    }

    if ((fimMin - inicioMin) < intervaloMinutos) {
        alert('O intervalo não pode ser maior que a janela de atendimento.');
        return false;
    }

    return true;
}

window.abrirModalAgendaMedico = function(modo = 'novo') {
    renderListaMedicosAgenda();

    if (modo === 'novo') {
        limparFormAgendaMedico();
    } else if (selecionadoAgendaMedico) {
        preencherFormAgendaMedico(selecionadoAgendaMedico);
    }

    fecharOutrosModais('modalAgendaMedico');
    abrirComAnimacao('modalAgendaMedico');
    if (modo === 'novo') {
        setTimeout(() => document.getElementById('agendaMedicoNome').focus(), 60);
    }
};

window.fecharModalAgendaMedico = function() {
    fecharComAnimacao('modalAgendaMedico');
};

window.salvarAgendaMedico = async function(event) {
    event.preventDefault();

    const idAtual = document.getElementById('agendaMedicoId').value.trim();
    const nome = document.getElementById('agendaMedicoNome').value.trim();
    const inicio = document.getElementById('agendaMedicoInicio').value;
    const fim = document.getElementById('agendaMedicoFim').value;
    const intervaloMinutos = Number(document.getElementById('agendaMedicoIntervalo').value);

    const diasSemana = Array.from(
        document.querySelectorAll('#formAgendaMedico .dias-semana-group input[type="checkbox"]:checked')
    ).map(el => Number(el.value)).sort((a, b) => a - b);

    if (!validarAgendaMedico({ nome, diasSemana, inicio, fim, intervaloMinutos })) {
        return;
    }

    const medicoPayload = {
        id: idAtual || slugifyId(nome) || `medico-${Date.now()}`,
        nome,
        diasSemana,
        inicio,
        fim,
        intervaloMinutos,
        datasBloqueadas: normalizarDatasBloqueadas(datasBloqueadasAgendaMedico)
    };

    if (idAtual) {
        const idx = medicosAgenda.findIndex(m => m.id === idAtual);
        if (idx !== -1) medicosAgenda[idx] = medicoPayload;
    } else {
        const idDuplicado = medicosAgenda.some(m => m.id === medicoPayload.id);
        if (idDuplicado) medicoPayload.id = `${medicoPayload.id}-${Date.now()}`;
        medicosAgenda.push(medicoPayload);
    }

    selecionadoAgendaMedico = medicoPayload;
    sincronizarNomesMedicoNosAgendamentos();

    await Promise.all([salvarMedicosAgenda(), salvarAgendamentos(), salvarRegistros()]);

    popularSelectMedicos(medicoPayload.id);
    atualizarHorariosDisponiveisInterno();
    renderListaMedicosAgenda();
    renderTabela();

    alert('Agenda médica salva com sucesso.');
};

window.excluirAgendaMedico = async function() {
    if (!selecionadoAgendaMedico) return;

    const medicoId = selecionadoAgendaMedico.id;
    const totalVinculos = agendamentos.filter(a => a.medicoId === medicoId).length;
    if (totalVinculos > 0) {
        alert(`Não é possível excluir. Existem ${totalVinculos} agendamento(s) vinculados a este médico.`);
        return;
    }

    const confirmou = await abrirModalConfirmacao({
        titulo: 'Excluir agenda médica',
        mensagem: `Deseja excluir a agenda de ${selecionadoAgendaMedico.nome}?`,
        textoConfirmar: 'Excluir'
    });
    if (!confirmou) return;

    medicosAgenda = medicosAgenda.filter(m => m.id !== medicoId);
    selecionadoAgendaMedico = null;

    await salvarMedicosAgenda();

    popularSelectMedicos(obterPrimeiroMedico()?.id || '');
    atualizarHorariosDisponiveisInterno();
    renderListaMedicosAgenda();

    if (medicosAgenda.length === 0) {
        limparFormAgendaMedico();
    }
};

ipcRenderer.on('change-theme', (event, theme) => setTheme(theme));

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await garantirAcesso(['admin', 'recepcao']);
        carregarTema();
        await carregarMedicosAgenda();
        popularSelectMedicos();

        await Promise.all([carregarAgendamentos(), carregarRegistros(), carregarPacientes(), carregarConfigSistema()]);

        document.getElementById('dataAgendamento').value = obterDataHojeIso();
        document.getElementById('btnNovoAgendamento')?.addEventListener('click', () => window.abrirModal('novo'));
        document.getElementById('cpfPaciente').addEventListener('blur', preencherPacientePorCpfOuProntuario);
        document.getElementById('prontuarioPaciente').addEventListener('blur', preencherPacientePorCpfOuProntuario);
        document.getElementById('pesquisa').value = '';

        atualizarHorariosDisponiveisInterno();
        renderListaMedicosAgenda();
        window.filtrarAgendamentos();
    } catch (error) {
        console.error('Falha ao inicializar módulo de agendamento:', error);
        alert(`Erro ao inicializar Agendamento: ${error.message}`);
    }
});
