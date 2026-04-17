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

let registros = [];
let pacientes = [];
let registroSelecionado = null;
let registrosFiltrados = [];
let registrosPorPagina = 50;
let paginaAtual = 1;
let registroAtualId = null;
let resizeTimer = null;
let sessaoAtual = null;
const dataVersions = { registros: 0, pacientes: 0 };

window.addEventListener('error', (event) => {
    console.error('Erro global em Registros:', event.error || event.message);
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('Promise rejeitada em Registros:', event.reason);
});

// Adicionar estas variÃ¡veis no inÃ­cio do arquivo
 // NÃºmero de registros exibidos inicialmente
let registrosAtuais = []; // Array com todos os registros filtrados/pesquisados

// FunÃ§Ã£o para aplicar tema (definida no inÃ­cio para garantir que seja executada primeiro)
function setTheme(theme) {
    if (typeof document !== 'undefined') {
        // Aplicar tanto no body quanto no html para garantir
        if (document.body) {
            document.body.classList.remove('dark-theme', 'light-theme', 'theme-azul');
        }
        if (document.documentElement) {
            document.documentElement.classList.remove('dark-theme', 'light-theme', 'theme-azul');
        }
        
        if (theme === 'dark') {
            if (document.body) document.body.classList.add('dark-theme');
            if (document.documentElement) document.documentElement.classList.add('dark-theme');
        } else if (theme === 'light') {
            if (document.body) document.body.classList.add('light-theme');
            if (document.documentElement) document.documentElement.classList.add('light-theme');
        } else if (theme === 'azul' || theme === 'blue') {
            if (document.body) document.body.classList.add('theme-azul');
            if (document.documentElement) document.documentElement.classList.add('theme-azul');
        }
        
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('theme', theme);
        }
    }
}

// Carregar tema salvo (executado imediatamente)
function loadTheme() {
    try {
        if (typeof document !== 'undefined' && typeof localStorage !== 'undefined') {
            const savedTheme = localStorage.getItem('theme') || 'azul';
            setTheme(savedTheme);
        }
    } catch (error) {
        console.error('Erro ao carregar tema:', error);
    }
}

// Executar carregamento do tema imediatamente (quando o script Ã© carregado)
// O tema jÃ¡ foi aplicado no HTML, mas vamos garantir que estÃ¡ correto
loadTheme();

// FunÃ§Ãµes de InicializaÃ§Ã£o
document.addEventListener('DOMContentLoaded', async () => {
    try {
        sessaoAtual = await garantirAcesso(['admin', 'recepcao', 'tecnico']);
        loadTheme();
        await carregarPacientes();
        await carregarRegistros();
        setupEventListeners();
        carregarFiltrosSalvos();
        registrosPorPagina = calcularRegistrosPorPagina();
        atualizarTabela();
        atualizarBotoesAcao();
    } catch (error) {
        console.error('Falha ao inicializar módulo de registros:', error);
        alert(`Erro ao inicializar Registros: ${error.message}`);
    }
});

// O evento do botÃ£o de relatÃ³rio Ã© configurado na funÃ§Ã£o de inicializaÃ§Ã£o dos grÃ¡ficos (linha 1084)

// Listener para eventos de tema do IPC
try {
    if (typeof ipcRenderer !== 'undefined' && ipcRenderer) {
        // Remover listener anterior se existir
        ipcRenderer.removeAllListeners('change-theme');
        // Adicionar novo listener
        ipcRenderer.on('change-theme', (event, theme) => {
            setTheme(theme);
        });
    }
} catch (error) {
    console.error('Erro ao configurar listener de tema:', error);
}

function setupEventListeners() {
    document.getElementById('btnNovoRegistro')?.addEventListener('click', () => abrirModal('novo'));
    // Listeners para os botÃµes principais
    document.getElementById('searchInput').addEventListener('input', handleSearchInput);
    document.getElementById('btnLimparPesquisa').addEventListener('click', limparPesquisa);
    document.getElementById('btnFiltrarAvancado').addEventListener('click', toggleFiltroAvancado);
    document.getElementById('btnAplicarFiltroAvancado').addEventListener('click', aplicarFiltroAvancado);
    document.getElementById('btnLimparFiltroAvancado').addEventListener('click', limparFiltroAvancado);
    document.getElementById('btnSalvarFiltroAvancado')?.addEventListener('click', salvarFiltroAvancadoAtual);
    document.getElementById('btnRemoverFiltroAvancado')?.addEventListener('click', removerFiltroAvancadoSelecionado);
    document.getElementById('filtroSalvoSelect')?.addEventListener('change', aplicarFiltroAvancadoSalvo);
    document.getElementById('btnExcluirRegistro').addEventListener('click', iniciarExclusao);

    // Listeners para ordenaÃ§Ã£o
    document.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => ordenarTabela(th));
    });

    // Atualiza o listener para a tabela
    const tbody = document.getElementById('listaExames');
    if (tbody) {
        // Remove o evento de clique antigo e adiciona o novo
        tbody.removeEventListener('click', handleRowClick);
        tbody.addEventListener('click', (event) => {
            const row = event.target.closest('tr');
            if (!row || !row.dataset.id) return;
            
            handleRowClick(row);
        });

        // Evento de duplo clique atualizado
        tbody.addEventListener('dblclick', (event) => {
            const row = event.target.closest('tr');
            if (!row || !row.dataset.id) return;
            
            const id = parseInt(row.dataset.id);
            const registro = registros.find(r => r.id === id);
            if (registro) {
                abrirModalObservacoes(registro);
            }
        });
    }

    // Adicionar listener para o botÃ£o de importar (se existir)
    const btnImportar = document.getElementById('btnImportar');
    if (btnImportar) {
        btnImportar.addEventListener('click', iniciarImportacao);
    }

    const cpfInput = document.getElementById('cpfPaciente');
    const prontuarioInput = document.getElementById('prontuarioPaciente');
    if (cpfInput) cpfInput.addEventListener('blur', preencherPacientePorCpfOuProntuario);
    if (prontuarioInput) prontuarioInput.addEventListener('blur', preencherPacientePorCpfOuProntuario);

    window.addEventListener('resize', () => {
        if (resizeTimer) {
            clearTimeout(resizeTimer);
        }
        resizeTimer = setTimeout(() => {
            ajustarPaginacaoResponsiva();
        }, 150);
    });
}

// Adicione estes listeners logo apÃ³s a definiÃ§Ã£o dos outros event listeners
ipcRenderer.on('show-export-modal', () => {
    abrirModalExportar();
});

ipcRenderer.on('start-import', () => {
    iniciarImportacao();
});

// FunÃ§Ãµes de ManipulaÃ§Ã£o de Registros
async function carregarRegistros() {
    const dados = await ipcRenderer.invoke('ler-registros');
    registros = Array.isArray(dados) ? dados : [];
    try {
        const v = await ipcRenderer.invoke('data-get-version', 'registros');
        dataVersions.registros = Number(v?.version || 0);
    } catch (error) {
        console.warn('Falha ao obter versão de registros:', error);
        dataVersions.registros = 0;
    }
    registros = registros.map(normalizarRegistro);
    registrosFiltrados = [...registros];
    atualizarTabela();
    // Atualizar ano selecionado baseado nos registros disponÃ­veis
    if (registros.length > 0) {
        const anos = new Set();
        registros.forEach(registro => {
            const data = new Date(registro.dataHoraExame);
            if (!isNaN(data.getTime())) {
                anos.add(data.getFullYear().toString());
            }
        });
        const anosOrdenados = Array.from(anos).sort((a, b) => parseInt(b) - parseInt(a));
        if (anosOrdenados.length > 0) {
            anoSelecionado = anosOrdenados[0];
        }
    }
}

async function salvarRegistros() {
    const ok = await ipcRenderer.invoke('salvar-registros', {
        data: registros,
        expectedVersion: dataVersions.registros,
        detalhe: 'Atualizacao via modulo de registros'
    });
    if (!ok) {
        throw new Error('Falha ao salvar registros (possível conflito de edição).');
    }
    const v = await ipcRenderer.invoke('data-get-version', 'registros');
    dataVersions.registros = Number(v?.version || dataVersions.registros);
}

async function carregarPacientes() {
    const dados = await ipcRenderer.invoke('ler-pacientes');
    pacientes = Array.isArray(dados) ? dados : [];
    try {
        const v = await ipcRenderer.invoke('data-get-version', 'pacientes');
        dataVersions.pacientes = Number(v?.version || 0);
    } catch (error) {
        console.warn('Falha ao obter versão de pacientes:', error);
        dataVersions.pacientes = 0;
    }
    if (!Array.isArray(pacientes)) {
        pacientes = [];
        return;
    }
    pacientes = pacientes.map(paciente => {
        const legado = extrairCpfOuProntuarioLegado(paciente.documentoPaciente || '');
        const prontuarioPaciente = String(paciente.prontuarioPaciente || legado.prontuarioPaciente || '').trim().toUpperCase();
        const cpfPaciente = cpfSomenteDigitos(paciente.cpfPaciente || legado.cpfPaciente || '');
        return {
            ...paciente,
            cpfPaciente,
            prontuarioPaciente,
            documentoPaciente: prontuarioPaciente || paciente.documentoPaciente || ''
        };
    });
}

async function salvarPacientes() {
    const ok = await ipcRenderer.invoke('salvar-pacientes', {
        data: pacientes,
        expectedVersion: dataVersions.pacientes,
        detalhe: 'Atualizacao de pacientes pelo modulo de registros'
    });
    if (!ok) {
        throw new Error('Falha ao salvar pacientes (possível conflito de edição).');
    }
    const v = await ipcRenderer.invoke('data-get-version', 'pacientes');
    dataVersions.pacientes = Number(v?.version || dataVersions.pacientes);
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

function obterProximoProntuarioRegistros() {
    const usados = new Set();
    [...pacientes, ...registros].forEach(item => {
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

function obterProximoNumeroAcessoRegistros() {
    const usados = new Set(registros.map(r => String(r.numeroAcesso || '').trim()).filter(Boolean));
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
    const legado = extrairCpfOuProntuarioLegado(registro.documentoPaciente || registro.pacienteDocumento || '');
    const prontuarioPaciente = String(registro.prontuarioPaciente || legado.prontuarioPaciente || '').trim().toUpperCase();
    const cpfPaciente = cpfSomenteDigitos(registro.cpfPaciente || legado.cpfPaciente || '');
    return {
        ...registro,
        statusExame: registro.statusExame || 'Agendado',
        cpfPaciente,
        prontuarioPaciente,
        documentoPaciente: prontuarioPaciente || registro.documentoPaciente || registro.pacienteDocumento || '',
        pacienteId: registro.pacienteId || ''
    };
}

function obterDataHoraLocalAtual() {
    return new Date().toLocaleString('sv').replace(' ', 'T').substring(0, 16);
}

function preencherPacientePorCpfOuProntuario() {
    const form = document.getElementById('formExame');
    const cpf = cpfSomenteDigitos(form.cpfPaciente.value);
    const prontuario = String(form.prontuarioPaciente.value || '').trim().toLowerCase();
    if (!cpf && !prontuario) return;

    const paciente = pacientes.find(p => {
        const prontuarioPaciente = String(p.prontuarioPaciente || p.documentoPaciente || '').trim().toLowerCase();
        const cpfPaciente = cpfSomenteDigitos(p.cpfPaciente || '');
        return (prontuario && prontuarioPaciente === prontuario) || (cpf && cpfPaciente === cpf);
    });
    if (!paciente) return;

    if (!form.nomePaciente.value.trim()) {
        form.nomePaciente.value = paciente.nomePaciente || '';
    }
    if (!form.cpfPaciente.value.trim()) {
        form.cpfPaciente.value = paciente.cpfPaciente || '';
    }
    if (!form.prontuarioPaciente.value.trim()) {
        form.prontuarioPaciente.value = paciente.prontuarioPaciente || paciente.documentoPaciente || '';
    }
    if (!form.telefonePaciente.value.trim()) {
        form.telefonePaciente.value = paciente.telefonePaciente || '';
    }
    if (!form.enderecoPaciente.value.trim()) {
        form.enderecoPaciente.value = paciente.enderecoPaciente || '';
    }
    if (!form.planoPaciente.value.trim()) {
        form.planoPaciente.value = paciente.planoPaciente || '';
    }
    if (!form.dataNascimentoPaciente.value) {
        form.dataNascimentoPaciente.value = paciente.dataNascimentoPaciente || '';
    }
}

// FunÃ§Ãµes para manipulaÃ§Ã£o do formulÃ¡rio
window.salvarExame = async function(event) {
    event.preventDefault();
    const form = document.getElementById('formExame');
    const nomePaciente = form.nomePaciente.value.trim();
    const cpfPaciente = cpfSomenteDigitos(form.cpfPaciente.value);
    const prontuarioPaciente = String(form.prontuarioPaciente.value || '').trim().toUpperCase();
    const documentoPaciente = prontuarioPaciente;
    const telefonePaciente = form.telefonePaciente.value.trim();
    const enderecoPaciente = form.enderecoPaciente.value.trim();
    const planoPaciente = form.planoPaciente.value.trim();
    const dataNascimentoPaciente = form.dataNascimentoPaciente.value || '';

    if (!prontuarioPaciente) {
        alert('Informe o prontuário do paciente.');
        return;
    }

    let paciente = pacientes.find(p =>
        String(p.prontuarioPaciente || p.documentoPaciente || '').toLowerCase() === prontuarioPaciente.toLowerCase() ||
        (cpfPaciente && cpfSomenteDigitos(p.cpfPaciente || '') === cpfPaciente)
    );
    if (!paciente) {
        paciente = {
            id: Date.now().toString(),
            nomePaciente,
            cpfPaciente,
            prontuarioPaciente,
            documentoPaciente,
            telefonePaciente,
            enderecoPaciente,
            planoPaciente,
            dataNascimentoPaciente
        };
        pacientes.push(paciente);
    } else {
        paciente.nomePaciente = nomePaciente || paciente.nomePaciente;
        paciente.cpfPaciente = cpfPaciente || paciente.cpfPaciente || '';
        paciente.prontuarioPaciente = prontuarioPaciente || paciente.prontuarioPaciente || paciente.documentoPaciente || '';
        paciente.documentoPaciente = paciente.prontuarioPaciente;
        paciente.telefonePaciente = telefonePaciente || paciente.telefonePaciente || '';
        paciente.enderecoPaciente = enderecoPaciente || paciente.enderecoPaciente || '';
        paciente.planoPaciente = planoPaciente || paciente.planoPaciente || '';
        paciente.dataNascimentoPaciente = dataNascimentoPaciente || paciente.dataNascimentoPaciente || '';
    }
    
    const novoExame = {
        id: registroSelecionado ? registroSelecionado.id : Date.now(),
        nomePaciente,
        cpfPaciente,
        prontuarioPaciente,
        documentoPaciente,
        pacienteId: paciente.id,
        modalidade: form.modalidade.value,
        observacoes: form.observacoes.value.trim(),
        numeroAcesso: form.numeroAcesso.value.trim(),
        dataHoraExame: form.dataHoraExame.value,
        nomeTecnico: form.nomeTecnico.value.trim(),
        statusExame: form.statusExame.value || 'Agendado'
    };

    if (registroSelecionado) {
        const index = registros.findIndex(r => r.id === registroSelecionado.id);
        registros[index] = novoExame;
    } else {
        registros.unshift(novoExame);
    }

    await Promise.all([salvarPacientes(), salvarRegistros()]);
    registrosFiltrados = [...registros];
    registroSelecionado = null;
    paginaAtual = 1;
    
    fecharModal();
    atualizarTabela();
    atualizarBotoesAcao();
}

window.abrirModal = abrirModal;
window.fecharModal = fecharModal;
window.limparCampos = limparCampos;

// FunÃ§Ãµes de UI
function calcularRegistrosPorPagina() {
    const alturaViewport = window.innerHeight || 900;
    const alturaUtil = Math.max(320, alturaViewport - 360);
    const linhasEstimadas = Math.floor(alturaUtil / 42);
    return Math.max(12, Math.min(80, linhasEstimadas));
}

function ajustarPaginacaoResponsiva() {
    const novoValor = calcularRegistrosPorPagina();
    if (novoValor === registrosPorPagina) {
        return;
    }
    registrosPorPagina = novoValor;
    paginaAtual = 1;
    atualizarTabela();
}

function atualizarTabela() {
    registrosAtuais = registrosFiltrados;
    const tbody = document.getElementById('listaExames');
    if (!tbody) {
        console.error('Elemento tbody nÃ£o encontrado');
        return;
    }

    tbody.innerHTML = ''; // Limpa a tabela
    
    const inicio = 0;
    const fim = Math.min(registrosPorPagina * paginaAtual, registrosAtuais.length);
    
    const fragment = document.createDocumentFragment();
    for (let i = inicio; i < fim; i++) {
        const registro = registrosAtuais[i];
        const tr = criarLinhaTabela(registro);
        if (registroSelecionado && registro.id === registroSelecionado.id) {
            tr.classList.add('selected');
        }
        fragment.appendChild(tr);
    }
    tbody.appendChild(fragment);

    atualizarBotaoCarregarMais(registrosAtuais.length);
    atualizarInfoRegistros(registrosAtuais.length);
    atualizarBotoesAcao();
}

function atualizarInfoRegistros(total) {
    const registrosExibidos = Math.min(registrosPorPagina * paginaAtual, total);
    const infoElement = document.getElementById('infoRegistros');
    infoElement.textContent = `Exibindo ${registrosExibidos} de ${total} registros`;
}

// Adicionar funÃ§Ã£o para atualizar visibilidade do botÃ£o "Carregar Mais"
function atualizarBotaoCarregarMais(totalRegistros) {
    const btnCarregarMais = document.getElementById('btnCarregarMais');
    const registrosExibidos = registrosPorPagina * paginaAtual;
    
    if (registrosExibidos >= totalRegistros) {
        btnCarregarMais.style.display = 'none';
    } else {
        btnCarregarMais.style.display = 'block';
    }
}

// Adicionar funÃ§Ã£o para carregar mais registros
function carregarMaisRegistros() {
    paginaAtual++;
    atualizarTabela();
}

// Adicionar reset da paginaÃ§Ã£o quando aplicar filtros ou fazer pesquisa
function resetPaginacao() {
    paginaAtual = 1;
    registrosPorPagina = calcularRegistrosPorPagina();
}

// FunÃ§Ãµes de Modal
function abrirModal(tipo) {
    const modal = document.getElementById('modalForm');
    const form = document.getElementById('formExame');
    const modalTitle = document.getElementById('modalTitle');
    const nomePacienteInput = document.getElementById('nomePaciente');
    const cpfPacienteInput = document.getElementById('cpfPaciente');
    const prontuarioPacienteInput = document.getElementById('prontuarioPaciente');
    const telefonePacienteInput = document.getElementById('telefonePaciente');
    const dataNascimentoPacienteInput = document.getElementById('dataNascimentoPaciente');
    const enderecoPacienteInput = document.getElementById('enderecoPaciente');
    const planoPacienteInput = document.getElementById('planoPaciente');
    const modalidadeInput = document.getElementById('modalidade');
    const observacoesInput = document.getElementById('observacoes');
    const numeroAcessoInput = document.getElementById('numeroAcesso');
    const dataHoraExameInput = document.getElementById('dataHoraExame');
    const nomeTecnicoInput = document.getElementById('nomeTecnico');
    const statusExameInput = document.getElementById('statusExame');

    if (!modal || !form || !modalTitle || !prontuarioPacienteInput || !numeroAcessoInput) {
        console.error('Estrutura do modal de registros não encontrada.');
        return;
    }
    
    if (tipo === 'novo') {
        registroSelecionado = null;
        limparCampos();
        prontuarioPacienteInput.value = obterProximoProntuarioRegistros();
        numeroAcessoInput.value = obterProximoNumeroAcessoRegistros();
        modalTitle.textContent = 'Novo Registro';
    } else if (tipo === 'editar' && registroSelecionado) {
        if (nomePacienteInput) nomePacienteInput.value = registroSelecionado.nomePaciente;
        if (cpfPacienteInput) cpfPacienteInput.value = registroSelecionado.cpfPaciente || '';
        prontuarioPacienteInput.value = registroSelecionado.prontuarioPaciente || registroSelecionado.documentoPaciente || '';
        if (modalidadeInput) modalidadeInput.value = registroSelecionado.modalidade;
        if (observacoesInput) observacoesInput.value = registroSelecionado.observacoes;
        numeroAcessoInput.value = registroSelecionado.numeroAcesso;
        if (dataHoraExameInput) dataHoraExameInput.value = registroSelecionado.dataHoraExame;
        if (nomeTecnicoInput) nomeTecnicoInput.value = registroSelecionado.nomeTecnico;
        if (statusExameInput) statusExameInput.value = registroSelecionado.statusExame || 'Agendado';

        const paciente = pacientes.find(p =>
            p.id === registroSelecionado.pacienteId ||
            String(p.prontuarioPaciente || p.documentoPaciente || '').toLowerCase() === String(registroSelecionado.prontuarioPaciente || registroSelecionado.documentoPaciente || '').toLowerCase()
        );
        if (cpfPacienteInput) cpfPacienteInput.value = cpfPacienteInput.value || paciente?.cpfPaciente || '';
        if (telefonePacienteInput) telefonePacienteInput.value = paciente?.telefonePaciente || '';
        if (enderecoPacienteInput) enderecoPacienteInput.value = paciente?.enderecoPaciente || '';
        if (planoPacienteInput) planoPacienteInput.value = paciente?.planoPaciente || '';
        if (dataNascimentoPacienteInput) dataNascimentoPacienteInput.value = paciente?.dataNascimentoPaciente || '';
        modalTitle.textContent = 'Editar Registro';
    }
    
    modal.classList.remove('show');
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('show'), 10);
}

function fecharModal() {
    const modal = document.getElementById('modalForm');
    modal.classList.remove('show');
    setTimeout(() => modal.style.display = 'none', 300);
}

function limparCampos() {
    const form = document.getElementById('formExame');
    const dataHoraExameInput = document.getElementById('dataHoraExame');
    const statusExameInput = document.getElementById('statusExame');
    const prontuarioInput = document.getElementById('prontuarioPaciente');
    if (!form) return;
    form.reset();
    if (dataHoraExameInput) dataHoraExameInput.value = obterDataHoraLocalAtual();
    if (statusExameInput) statusExameInput.value = 'Agendado';
    if (prontuarioInput) prontuarioInput.focus();
}

// FunÃ§Ãµes Auxiliares
function formatarData(dataString) {
    if (!dataString) return '';
    
    try {
        const data = new Date(dataString);
        if (isNaN(data.getTime())) return 'Data invÃ¡lida';
        
        return data.toLocaleString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (error) {
        console.error('Erro ao formatar data:', error);
        return 'Data invÃ¡lida';
    }
}

function handleRowClick(row) {
    const id = parseInt(row.dataset.id);
    const registro = registros.find(r => r.id === id);
    
    if (!registro) return;

    // Remove seleÃ§Ã£o de todas as linhas
    document.querySelectorAll('tr.selected').forEach(tr => {
        tr.classList.remove('selected');
    });

    if (registroSelecionado && registroSelecionado.id === id) {
        // Se clicou na linha jÃ¡ selecionada, remove a seleÃ§Ã£o
        registroSelecionado = null;
        row.classList.remove('selected');
    } else {
        // Seleciona a nova linha
        row.classList.add('selected');
        registroSelecionado = registro;
    }

    atualizarBotoesAcao();
}

// FunÃ§Ãµes para Pesquisa e Filtros
function handleSearchInput(event) {
    const searchText = event.target.value.toLowerCase();
    document.getElementById('btnLimparPesquisa').style.display = searchText ? 'block' : 'none';
    
    registrosFiltrados = registros.filter(registro => {
        return Object.values(registro).some(value => 
            String(value).toLowerCase().includes(searchText)
        );
    });
    
    paginaAtual = 1;
    atualizarTabela();
}

function limparPesquisa() {
    document.getElementById('searchInput').value = '';
    document.getElementById('btnLimparPesquisa').style.display = 'none';
    registrosFiltrados = [...registros];
    paginaAtual = 1;
    atualizarTabela();
}

function toggleFiltroAvancado() {
    const container = document.getElementById('filtroAvancadoContainer');
    container.style.display = container.style.display === 'none' ? 'block' : 'none';
}

function aplicarFiltroAvancado() {
    resetPaginacao();
    const modalidade = document.getElementById('filtroModalidade').value;
    const dataInicio = document.getElementById('dataInicio').value;
    const horaInicio = document.getElementById('horaInicio').value;
    const dataFim = document.getElementById('dataFim').value;
    const horaFim = document.getElementById('horaFim').value;

    const inicio = dataInicio ? new Date(`${dataInicio}T${horaInicio}`) : null;
    const fim = dataFim ? new Date(`${dataFim}T${horaFim}`) : null;

    registrosFiltrados = registros.filter(registro => {
        const dataExame = new Date(registro.dataHoraExame);
        const passaModalidade = !modalidade || registro.modalidade === modalidade;
        const passaData = (!inicio || dataExame >= inicio) && (!fim || dataExame <= fim);
        return passaModalidade && passaData;
    });

    paginaAtual = 1;
    atualizarTabela();
}

function limparFiltroAvancado() {
    document.getElementById('filtroModalidade').value = '';
    document.getElementById('dataInicio').value = '';
    document.getElementById('horaInicio').value = '00:00';
    document.getElementById('dataFim').value = '';
    document.getElementById('horaFim').value = '23:59';
    registrosFiltrados = [...registros];
    paginaAtual = 1;
    atualizarTabela();
}

function getFiltroStorageKey() {
    const user = String(sessaoAtual?.username || 'anon');
    return `registros:filtros:${user}`;
}

function lerFiltrosSalvos() {
    try {
        const raw = localStorage.getItem(getFiltroStorageKey());
        const lista = JSON.parse(raw || '[]');
        return Array.isArray(lista) ? lista : [];
    } catch (error) {
        return [];
    }
}

function salvarFiltrosSalvos(lista) {
    localStorage.setItem(getFiltroStorageKey(), JSON.stringify(Array.isArray(lista) ? lista : []));
}

function carregarFiltrosSalvos() {
    const select = document.getElementById('filtroSalvoSelect');
    if (!select) return;
    const lista = lerFiltrosSalvos();
    const opcoes = ['<option value="">Filtros salvos</option>']
        .concat(lista.map((item, idx) => `<option value="${idx}">${String(item.nome || `Filtro ${idx + 1}`)}</option>`));
    select.innerHTML = opcoes.join('');
}

function obterFiltroAvancadoAtual() {
    return {
        modalidade: document.getElementById('filtroModalidade').value,
        dataInicio: document.getElementById('dataInicio').value,
        horaInicio: document.getElementById('horaInicio').value,
        dataFim: document.getElementById('dataFim').value,
        horaFim: document.getElementById('horaFim').value
    };
}

function aplicarFiltroAvancadoSalvo() {
    const select = document.getElementById('filtroSalvoSelect');
    if (!select || select.value === '') return;
    const index = Number(select?.value);
    if (!Number.isFinite(index)) return;
    const lista = lerFiltrosSalvos();
    const filtro = lista[index];
    if (!filtro) return;
    document.getElementById('filtroModalidade').value = filtro.modalidade || '';
    document.getElementById('dataInicio').value = filtro.dataInicio || '';
    document.getElementById('horaInicio').value = filtro.horaInicio || '00:00';
    document.getElementById('dataFim').value = filtro.dataFim || '';
    document.getElementById('horaFim').value = filtro.horaFim || '23:59';
    aplicarFiltroAvancado();
}

function salvarFiltroAvancadoAtual() {
    const nome = window.prompt('Nome do filtro salvo:');
    if (!nome) return;
    const lista = lerFiltrosSalvos();
    lista.push({
        nome: String(nome).trim(),
        ...obterFiltroAvancadoAtual()
    });
    salvarFiltrosSalvos(lista.slice(-20));
    carregarFiltrosSalvos();
}

function removerFiltroAvancadoSelecionado() {
    const select = document.getElementById('filtroSalvoSelect');
    if (!select || select.value === '') return;
    const index = Number(select?.value);
    if (!Number.isFinite(index)) return;
    const lista = lerFiltrosSalvos();
    if (!lista[index]) return;
    lista.splice(index, 1);
    salvarFiltrosSalvos(lista);
    carregarFiltrosSalvos();
}

// FunÃ§Ãµes para OrdenaÃ§Ã£o
function ordenarTabela(th) {
    const campos = ['nomePaciente', 'modalidade', 'observacoes', 'numeroAcesso', 'dataHoraExame', 'nomeTecnico'];
    const campo = campos[th.cellIndex];
    const ordem = th.dataset.sort === 'asc' ? 1 : -1;
    
    registrosFiltrados.sort((a, b) => {
        if (campo === 'dataHoraExame') {
            // OrdenaÃ§Ã£o especial para datas
            const dataA = new Date(a[campo]);
            const dataB = new Date(b[campo]);
            return (dataA - dataB) * ordem;
        } else {
            // OrdenaÃ§Ã£o para texto
            const valorA = String(a[campo]).toLowerCase();
            const valorB = String(b[campo]).toLowerCase();
            return valorA.localeCompare(valorB) * ordem;
        }
    });
    
    // Atualiza o indicador de ordenaÃ§Ã£o em todas as colunas
    document.querySelectorAll('th[data-sort]').forEach(header => {
        header.dataset.sort = header === th ? (ordem === 1 ? 'desc' : 'asc') : 'asc';
    });
    
    atualizarTabela();
}

// FunÃ§Ãµes para ExclusÃ£o
function iniciarExclusao() {
    if (!registroSelecionado) return;

    const modalConfirmacao = document.getElementById('modalConfirmacao');
    const btnConfirmar = modalConfirmacao.querySelector('.btn-confirmar');
    const btnCancelar = modalConfirmacao.querySelector('.btn-cancelar');
    const fechar = modalConfirmacao.querySelector('.close');

    const fecharModalConfirmacao = () => {
        modalConfirmacao.classList.remove('show');
        setTimeout(() => {
            modalConfirmacao.style.display = 'none';
            // Limpar todos os event listeners
            btnConfirmar.onclick = null;
            btnCancelar.onclick = null;
            fechar.onclick = null;
        }, 300);
    };

    const confirmarExclusao = async () => {
        const index = registros.findIndex(r => r.id === registroSelecionado.id);
        if (index !== -1) {
            registros.splice(index, 1);
            registrosFiltrados = registrosFiltrados.filter(r => r.id !== registroSelecionado.id);
            registroSelecionado = null;
            try {
                await salvarRegistros();
            } catch (error) {
                alert(error.message || 'Erro ao salvar alterações.');
                carregarRegistros();
            }
            atualizarTabela();
            atualizarBotoesAcao();
        }
        fecharModalConfirmacao();
    };

    // Configurar event listeners
    btnConfirmar.onclick = confirmarExclusao;
    btnCancelar.onclick = fecharModalConfirmacao;
    fechar.onclick = fecharModalConfirmacao;

    // Abrir modal com animaÃ§Ã£o
    modalConfirmacao.style.display = 'flex';
    setTimeout(() => modalConfirmacao.classList.add('show'), 10);
}

// FunÃ§Ãµes para ExportaÃ§Ã£o
function abrirModalExportar() {
    const modal = document.getElementById('modalExportar');
    
    // Adicionar listeners para os radio buttons
    document.querySelectorAll('input[name="filtroExport"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const exportDateFields = document.getElementById('exportDateFields');
            exportDateFields.style.display = e.target.value === 'periodo' ? 'block' : 'none';
        });
    });

    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('show'), 10);
}

// Adicione este cÃ³digo apÃ³s a definiÃ§Ã£o da funÃ§Ã£o abrirModalExportar
document.querySelectorAll('input[name="filtroExport"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        const dateFields = document.getElementById('exportDateFields');
        dateFields.style.display = e.target.value === 'periodo' ? 'block' : 'none';
    });
});

async function exportarRegistros(tipo) {
    try {
        const registrosParaExportar = obterRegistrosFiltradosExportacao();
        if (registrosParaExportar.length === 0) {
            alert('Não há registros para exportar.');
            return;
        }

        if (tipo === 'backup') {
            // Para backup, enviar os registros brutos
            await ipcRenderer.invoke('salvar-arquivo', {
                conteudo: JSON.stringify(registrosParaExportar, null, 2),
                tipo: 'json'
            });
        } else if (tipo === 'pdf') {
            await ipcRenderer.invoke('exportar-pdf', registrosParaExportar);
        }
        // ... restante do cÃ³digo existente ...
        fecharModalExportar();
    } catch (error) {
        console.error('Erro ao exportar:', error);
        alert('Erro ao exportar: ' + error.message);
    }
}

function fecharModalExportar() {
    const modal = document.getElementById('modalExportar');
    modal.classList.remove('show');
    
    // Resetar campos ao fechar
    document.getElementById('exportDateFields').style.display = 'none';
    document.querySelector('input[name="filtroExport"][value="todos"]').checked = true;
    document.getElementById('exportDataInicio').value = '';
    document.getElementById('exportDataFim').value = '';
    document.getElementById('exportHoraInicio').value = '00:00';
    document.getElementById('exportHoraFim').value = '23:59';
    
    setTimeout(() => modal.style.display = 'none', 300);
}

function obterRegistrosFiltradosExportacao() {
    const filtro = document.querySelector('input[name="filtroExport"]:checked').value;
    
    if (filtro === 'todos') {
        return registrosFiltrados;
    } else if (filtro === 'periodo') {
        const dataInicio = document.getElementById('exportDataInicio').value;
        const horaInicio = document.getElementById('exportHoraInicio').value || '00:00';
        const dataFim = document.getElementById('exportDataFim').value;
        const horaFim = document.getElementById('exportHoraFim').value || '23:59';

        if (!dataInicio || !dataFim) {
            alert('Por favor, preencha as datas inicial e final');
            return [];
        }

        const inicio = new Date(`${dataInicio}T${horaInicio}`);
        const fim = new Date(`${dataFim}T${horaFim}`);

        return registrosFiltrados.filter(registro => {
            const dataExame = new Date(registro.dataHoraExame);
            return dataExame >= inicio && dataExame <= fim;
        });
    }
    return [];
}

// Adicionar o evento de clique para exportaÃ§Ã£o Excel
document.addEventListener('DOMContentLoaded', () => {
    // ...existing code...

    // Adicionar handler para exportaÃ§Ã£o Excel
    document.getElementById('exportarCSV').addEventListener('click', async () => {
        try {
            const registrosParaExportar = obterRegistrosFiltradosExportacao();
            if (registrosParaExportar.length === 0) {
                alert('Não há registros para exportar.');
                return;
            }
            
            await ipcRenderer.invoke('exportar-csv', registrosParaExportar);
            fecharModalExportar();
        } catch (error) {
            console.error('Erro ao exportar Excel:', error);
            alert('Erro ao exportar para Excel: ' + error.message);
        }
    });
});

function criarLinhaTabela(registro) {
    const tr = document.createElement('tr');
    tr.dataset.id = registro.id.toString();
    const documentoExibicao = registro.prontuarioPaciente || registro.documentoPaciente || registro.cpfPaciente || '';
    const nomeComDocumento = documentoExibicao
        ? `${registro.nomePaciente || ''} (${documentoExibicao})`
        : (registro.nomePaciente || '');
    tr.innerHTML = `
        <td data-label="Paciente">${nomeComDocumento}</td>
        <td data-label="Modalidade">${registro.modalidade || ''}</td>
        <td data-label="Exame">${registro.observacoes || ''}</td>
        <td data-label="No Acesso">${registro.numeroAcesso || ''}</td>
        <td data-label="Data/Hora">${formatarData(registro.dataHoraExame) || ''}</td>
        <td data-label="Tecnico">${registro.nomeTecnico || ''}</td>
        <td data-label="Obs" class="cell-with-obs">${registro.observacoesAdicionais ? '<span class="obs-icon">📝</span>' : ''}</td>
    `;
    return tr;
}

function atualizarBotoesAcao() {
    document.getElementById('btnEditarRegistro').disabled = !registroSelecionado;
    document.getElementById('btnExcluirRegistro').disabled = !registroSelecionado;
    const btnHistorico = document.getElementById('btnHistoricoPaciente');
    if (btnHistorico) {
        btnHistorico.disabled = !registroSelecionado;
    }
}

function abrirModalObservacoes(registro) {
    const modal = document.getElementById('modalObservacoes');
    document.getElementById('observacoesAdicionais').value = registro.observacoesAdicionais || '';
    registroAtualId = registro.id;
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('show'), 10);
}

function fecharModalObservacoes() {
    const modal = document.getElementById('modalObservacoes');
    modal.classList.remove('show');
    setTimeout(() => modal.style.display = 'none', 300);
    registroAtualId = null;
}

async function salvarObservacoes() {
    const observacoes = document.getElementById('observacoesAdicionais').value;
    if (!registroAtualId) return;
    const index = registros.findIndex(r => r.id === registroAtualId);
    if (index !== -1) {
        registros[index].observacoesAdicionais = observacoes;
        try {
            await salvarRegistros();
        } catch (error) {
            alert(error.message || 'Erro ao salvar observações.');
            await carregarRegistros();
        }
        atualizarTabela();
        fecharModalObservacoes();
    }
}

window.abrirHistoricoPaciente = async function() {
    if (!registroSelecionado) {
        alert('Selecione um registro para visualizar o histórico do paciente.');
        return;
    }
    await renderizarHistoricoPaciente(
        registroSelecionado.prontuarioPaciente || registroSelecionado.documentoPaciente || registroSelecionado.cpfPaciente || '',
        registroSelecionado.nomePaciente
    );
}

window.abrirHistoricoPorCadastro = async function() {
    const form = document.getElementById('formExame');
    const documento = (form.prontuarioPaciente.value || form.cpfPaciente.value || '').trim();
    const nome = form.nomePaciente.value.trim();
    if (!documento && !nome) {
        alert('Informe o CPF, prontuário ou nome para consultar o histórico.');
        return;
    }
    await renderizarHistoricoPaciente(documento, nome);
}

window.fecharModalHistorico = function() {
    const modal = document.getElementById('modalHistoricoPaciente');
    modal.classList.remove('show');
    setTimeout(() => {
        modal.style.display = 'none';
        document.getElementById('historicoPacienteInfo').textContent = '';
        document.getElementById('historicoPacienteLista').innerHTML = '';
    }, 300);
}

async function renderizarHistoricoPaciente(documentoPaciente, nomePaciente = '') {
    const modal = document.getElementById('modalHistoricoPaciente');
    const info = document.getElementById('historicoPacienteInfo');
    const lista = document.getElementById('historicoPacienteLista');
    const result = await ipcRenderer.invoke('patient-timeline', {
        documento: documentoPaciente,
        nome: nomePaciente
    });
    if (!result?.ok) {
        info.textContent = result?.message || 'Erro ao consultar histórico.';
        lista.innerHTML = '';
        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('show'), 10);
        return;
    }

    const timeline = Array.isArray(result.timeline) ? result.timeline : [];
    const nomeExibicao = result.nomeExibicao || nomePaciente || 'Paciente';
    const documentoExibicao = result.documentoExibicao || documentoPaciente || '-';
    info.textContent = `${nomeExibicao} - ${documentoExibicao} | ${timeline.length} item(s)`;

    if (timeline.length === 0) {
        lista.innerHTML = '<p>Nenhum histórico encontrado para este paciente.</p>';
    } else {
        const linhas = timeline.map(exame => `
            <tr>
                <td>${exame.origem || ''}</td>
                <td>${formatarData(exame.data)}</td>
                <td>${exame.status || ''}</td>
                <td>${exame.modalidade || ''}</td>
                <td>${exame.exame || ''}</td>
                <td>${exame.acesso || ''}</td>
                <td>${exame.tecnico || ''}</td>
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
                        <th>Acesso</th>
                        <th>Técnico</th>
                    </tr>
                </thead>
                <tbody>${linhas}</tbody>
            </table>
        `;
    }

    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('show'), 10);
}

// Adicione as novas funÃ§Ãµes de importaÃ§Ã£o
let registrosParaImportar = null;

function abrirModalImportacao(novosRegistros) {
    registrosParaImportar = novosRegistros;
    const modal = document.getElementById('modalImportacao');
    
    if (!modal) {
        console.error('Modal de importaÃ§Ã£o nÃ£o encontrado');
        return;
    }

    const btnSubstituir = modal.querySelector('.btn-substituir');
    const btnAdicionar = modal.querySelector('.btn-adicionar');
    const btnCancelar = modal.querySelector('.btn-cancelar');
    const btnFechar = modal.querySelector('.close');

    function fecharModal() {
        modal.classList.remove('show');
        setTimeout(() => {
            modal.style.display = 'none';
            registrosParaImportar = null;
        }, 300);
    }

    btnSubstituir.onclick = async () => {
        if (registrosParaImportar) {
            registros = registrosParaImportar;
            registrosFiltrados = [...registros];
            await salvarRegistros();
            atualizarTabela();
            fecharModal();
        }
    };

    btnAdicionar.onclick = async () => {
        if (registrosParaImportar) {
            const idsExistentes = new Set(registros.map(r => r.id));
            const novosRegistros = registrosParaImportar.filter(r => !idsExistentes.has(r.id));
            registros = [...registros, ...novosRegistros];
            registrosFiltrados = [...registros];
            await salvarRegistros();
            atualizarTabela();
            fecharModal();
        }
    };

    btnCancelar.onclick = fecharModal;
    btnFechar.onclick = fecharModal;

    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('show'), 10);
}

// FunÃ§Ã£o para iniciar o processo de importaÃ§Ã£o
async function iniciarImportacao() {
    try {
        await ipcRenderer.invoke('importar-arquivo');
    } catch (error) {
        console.error('Erro ao iniciar importaÃ§Ã£o:', error);
        alert('Erro ao iniciar importaÃ§Ã£o de arquivo');
    }
}

// Atualizar o event listener para arquivos importados
ipcRenderer.on('arquivo-importado', (event, dados) => {
    console.log('Recebendo dados importados');
    try {
        const novosRegistros = JSON.parse(dados);
        if (!Array.isArray(novosRegistros)) {
            throw new Error('Formato invÃ¡lido: os dados nÃ£o sÃ£o um array');
        }
        
        if (novosRegistros.length === 0) {
            alert('O arquivo nÃ£o contÃ©m registros.');
            return;
        }

        // Verifica se os registros tÃªm o formato correto
        const formatoValido = novosRegistros.every(registro => 
            registro.hasOwnProperty('nomePaciente') && 
            registro.hasOwnProperty('modalidade') &&
            registro.hasOwnProperty('numeroAcesso')
        );

        if (!formatoValido) {
            alert('O arquivo contÃ©m registros em formato invÃ¡lido.');
            return;
        }

        // Abre o modal de importaÃ§Ã£o
        const modal = document.getElementById('modalImportacao');
        if (!modal) {
            console.error('Modal de importaÃ§Ã£o nÃ£o encontrado');
            return;
        }

        registrosParaImportar = novosRegistros;
        
        // Configura os botÃµes do modal
        const btnSubstituir = modal.querySelector('.btn-substituir');
        const btnAdicionar = modal.querySelector('.btn-adicionar');
        const btnCancelar = modal.querySelector('.btn-cancelar');
        const btnFechar = modal.querySelector('.close');

        function fecharModalImportacao() {
            modal.classList.remove('show');
            setTimeout(() => {
                modal.style.display = 'none';
                registrosParaImportar = null;
            }, 300);
        }

        btnSubstituir.onclick = async () => {
            registros = [...novosRegistros];
            registrosFiltrados = [...registros];
            await salvarRegistros();
            atualizarTabela();
            fecharModalImportacao();
        };

        btnAdicionar.onclick = async () => {
            const idsExistentes = new Set(registros.map(r => r.id));
            const registrosAdicionais = novosRegistros.filter(r => !idsExistentes.has(r.id));
            registros = [...registros, ...registrosAdicionais];
            registrosFiltrados = [...registros];
            await salvarRegistros();
            atualizarTabela();
            fecharModalImportacao();
        };

        btnCancelar.onclick = fecharModalImportacao;
        btnFechar.onclick = fecharModalImportacao;

        // Exibe o modal com animaÃ§Ã£o
        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('show'), 10);

    } catch (error) {
        console.error('Erro ao processar arquivo importado:', error);
        alert('Erro ao processar o arquivo. Verifique se o formato estÃ¡ correto.');
    }
});

// VariÃ¡veis globais para o grÃ¡fico
let chartInstance = null;
let modalidadeSelecionada = 'Tudo';
let anoSelecionado = new Date().getFullYear().toString();

// FunÃ§Ã£o para fechar o modal de grÃ¡fico
window.fecharModalGrafico = function() {
    const modal = document.getElementById('modalGrafico');
    if (!modal) return;
    
    modal.classList.remove('show');
    setTimeout(() => {
        modal.style.display = 'none';
        // Destruir o grÃ¡fico ao fechar
        if (chartInstance) {
            try {
                chartInstance.destroy();
            } catch (e) {
                console.error('Erro ao destruir grÃ¡fico:', e);
            }
            chartInstance = null;
        }
    }, 300);
}

// VariÃ¡vel para controlar se os dropdowns jÃ¡ foram inicializados
let dropdownsInicializados = false;

// FunÃ§Ã£o para inicializar os dropdowns
function inicializarDropdowns() {
    // Evitar mÃºltiplas inicializaÃ§Ãµes
    if (dropdownsInicializados) {
        atualizarAnosDropdown();
        return;
    }
    
    // Dropdown de modalidade
    const modalidadeButton = document.getElementById('modalidadeDropdownButton');
    const modalidadeMenu = document.getElementById('modalidadeDropdownMenu');
    
    if (modalidadeButton && modalidadeMenu) {
        modalidadeButton.addEventListener('click', (e) => {
            e.stopPropagation();
            modalidadeMenu.classList.toggle('show');
        });
        
        modalidadeMenu.querySelectorAll('li').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                modalidadeSelecionada = item.dataset.modalidade;
                modalidadeButton.textContent = item.textContent;
                modalidadeMenu.classList.remove('show');
                atualizarGrafico();
            });
        });
    }
    
    // Inicializar dropdown de ano
    atualizarAnosDropdown();
    
    // BotÃ£o de exportar PDF
    const exportPDFButton = document.getElementById('exportPDF');
    if (exportPDFButton && !exportPDFButton.hasAttribute('data-initialized')) {
        exportPDFButton.setAttribute('data-initialized', 'true');
        exportPDFButton.addEventListener('click', exportarGraficoPDF);
    }
    
    dropdownsInicializados = true;
}

// FunÃ§Ã£o para atualizar o dropdown de anos
function atualizarAnosDropdown() {
    const yearButton = document.getElementById('yearDropdownButton');
    const yearMenu = document.getElementById('yearDropdownMenu');
    
    if (yearButton && yearMenu) {
        // Extrair anos Ãºnicos dos registros
        const anos = new Set();
        (registros || []).forEach(registro => {
            if (registro && registro.dataHoraExame) {
                const data = new Date(registro.dataHoraExame);
                if (!isNaN(data.getTime())) {
                    anos.add(data.getFullYear().toString());
                }
            }
        });
        
        // Ordenar anos em ordem decrescente
        const anosOrdenados = Array.from(anos).sort((a, b) => parseInt(b) - parseInt(a));
        
        // Se nÃ£o houver anos, usar o ano atual
        if (anosOrdenados.length === 0) {
            anosOrdenados.push(new Date().getFullYear().toString());
        }
        
        // Limpar menu e adicionar anos
        yearMenu.innerHTML = '';
        anosOrdenados.forEach(ano => {
            const li = document.createElement('li');
            li.textContent = ano;
            li.dataset.ano = ano;
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                anoSelecionado = ano;
                yearButton.textContent = `Ano: ${ano}`;
                yearMenu.classList.remove('show');
                atualizarGrafico();
            });
            yearMenu.appendChild(li);
        });
        
        // Definir ano padrÃ£o se ainda nÃ£o estiver definido
        if (anosOrdenados.length > 0 && (!anoSelecionado || !anosOrdenados.includes(anoSelecionado))) {
            anoSelecionado = anosOrdenados[0];
            yearButton.textContent = `Ano: ${anoSelecionado}`;
        } else if (anoSelecionado) {
            yearButton.textContent = `Ano: ${anoSelecionado}`;
        }
        
        // Adicionar listener apenas uma vez
        if (!yearButton.hasAttribute('data-initialized')) {
            yearButton.setAttribute('data-initialized', 'true');
            yearButton.addEventListener('click', (e) => {
                e.stopPropagation();
                yearMenu.classList.toggle('show');
            });
        }
    }
    
    // Fechar dropdowns ao clicar fora (adicionar apenas uma vez)
    if (!window.dropdownClickHandlerAdded) {
        window.dropdownClickHandlerAdded = true;
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.dropdown')) {
                document.querySelectorAll('.dropdown-menu').forEach(menu => {
                    menu.classList.remove('show');
                });
            }
        });
    }
}

// FunÃ§Ã£o para atualizar o grÃ¡fico
function atualizarGrafico() {
    try {
        // Verificar se Chart.js estÃ¡ disponÃ­vel
        if (typeof Chart === 'undefined') {
            console.error('Chart.js nÃ£o estÃ¡ carregado');
            alert('Erro: Chart.js nÃ£o estÃ¡ carregado. Verifique a conexÃ£o com a internet.');
            return;
        }
        
        // Filtrar registros por modalidade e ano
        const registrosFiltrados = (registros || []).filter(registro => {
            if (!registro || !registro.dataHoraExame) return false;
            const data = new Date(registro.dataHoraExame);
            if (isNaN(data.getTime())) return false;
            
            const ano = data.getFullYear().toString();
            const passaAno = ano === anoSelecionado;
            const passaModalidade = modalidadeSelecionada === 'Tudo' || registro.modalidade === modalidadeSelecionada;
            
            return passaAno && passaModalidade;
        });
        
        // Agrupar por mes
        const dadosPorMes = {};
        const meses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 
                       'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
        
        registrosFiltrados.forEach(registro => {
            const data = new Date(registro.dataHoraExame);
            if (!isNaN(data.getTime())) {
                const mes = data.getMonth();
                const chave = meses[mes];
                
                if (!dadosPorMes[chave]) {
                    dadosPorMes[chave] = 0;
                }
                dadosPorMes[chave]++;
            }
        });
        
        // Preparar dados para o grÃ¡fico - mostrar todos os meses
        const labels = meses;
        const valores = meses.map(mes => dadosPorMes[mes] || 0);
        
        // Obter o canvas
        const canvas = document.getElementById('barChart');
        if (!canvas) {
            console.error('Canvas nÃ£o encontrado');
            return;
        }
        
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            console.error('Não foi possível obter o contexto do canvas');
            return;
        }
        
        // Destruir grÃ¡fico anterior se existir
        if (chartInstance) {
            chartInstance.destroy();
            chartInstance = null;
        }
        
        // Criar novo grÃ¡fico
        chartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Número de Exames',
                    data: valores,
                    backgroundColor: 'rgba(79, 129, 189, 0.8)',
                    borderColor: 'rgba(79, 129, 189, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top'
                    },
                    title: {
                        display: true,
                        text: `Exames por Mês - ${anoSelecionado}${modalidadeSelecionada !== 'Tudo' ? ' - ' + modalidadeSelecionada : ''}`
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            stepSize: 1
                        }
                    }
                }
            }
        });
        
        // Atualizar relatÃ³rio
        atualizarRelatorio(registrosFiltrados, dadosPorMes);
    } catch (error) {
        console.error('Erro ao atualizar grÃ¡fico:', error);
        alert('Erro ao atualizar grÃ¡fico: ' + error.message);
    }
}

// FunÃ§Ã£o para atualizar o relatÃ³rio
function atualizarRelatorio(registrosFiltrados, dadosPorMes) {
    const relatorioContent = document.getElementById('relatorioContent');
    if (!relatorioContent) return;
    
    const totalExames = registrosFiltrados.length;
    const totalPorModalidade = {};
    
    registrosFiltrados.forEach(registro => {
        const modalidade = registro.modalidade || 'Não especificado';
        totalPorModalidade[modalidade] = (totalPorModalidade[modalidade] || 0) + 1;
    });
    
    let html = `<p><strong>Total de Exames:</strong> ${totalExames}</p>`;
    
    if (modalidadeSelecionada === 'Tudo') {
        html += '<p><strong>Por Modalidade:</strong></p><ul>';
        Object.keys(totalPorModalidade).sort().forEach(modalidade => {
            html += `<li>${modalidade}: ${totalPorModalidade[modalidade]}</li>`;
        });
        html += '</ul>';
    }
    
    html += '<p><strong>Por Mês:</strong></p><ul>';
    const meses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 
                   'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    
    meses.forEach(mes => {
        if (dadosPorMes[mes]) {
            html += `<li>${mes}: ${dadosPorMes[mes]}</li>`;
        }
    });
    html += '</ul>';
    
    relatorioContent.innerHTML = html;
}

// FunÃ§Ã£o para exportar grÃ¡fico como PDF
async function exportarGraficoPDF() {
    try {
        if (!chartInstance) {
            alert('Nenhum grÃ¡fico para exportar');
            return;
        }
        
        // Filtrar registros por modalidade e ano (mesmo filtro usado no grÃ¡fico)
        const registrosFiltrados = (registros || []).filter(registro => {
            if (!registro || !registro.dataHoraExame) return false;
            const data = new Date(registro.dataHoraExame);
            if (isNaN(data.getTime())) return false;
            
            const ano = data.getFullYear().toString();
            const passaAno = ano === anoSelecionado;
            const passaModalidade = modalidadeSelecionada === 'Tudo' || registro.modalidade === modalidadeSelecionada;
            
            return passaAno && passaModalidade;
        });
        
        // Calcular dados do relatÃ³rio
        const totalExames = registrosFiltrados.length;
        const totalPorModalidade = {};
        const dadosPorMes = {};
        const meses = ['Janeiro', 'Fevereiro', 'MarÃ§o', 'Abril', 'Maio', 'Junho', 
                       'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
        
        registrosFiltrados.forEach(registro => {
            // Por modalidade
            const modalidade = registro.modalidade || 'Não especificado';
            totalPorModalidade[modalidade] = (totalPorModalidade[modalidade] || 0) + 1;
            
            // Por mes
            const data = new Date(registro.dataHoraExame);
            if (!isNaN(data.getTime())) {
                const mes = data.getMonth();
                const nomeMes = meses[mes];
                dadosPorMes[nomeMes] = (dadosPorMes[nomeMes] || 0) + 1;
            }
        });
        
        // Usar jsPDF para criar o PDF
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('landscape', 'mm', 'a4');
        
        let yPos = 20; // PosiÃ§Ã£o vertical inicial
        
        // Adicionar tÃ­tulo
        pdf.setFontSize(18);
        pdf.setFont(undefined, 'bold');
        pdf.text('RelatÃ³rio de Exames MÃ©dicos', 148.5, yPos, { align: 'center' });
        yPos += 10;
        
        // Adicionar informaÃ§Ãµes do filtro
        pdf.setFontSize(12);
        pdf.setFont(undefined, 'normal');
        pdf.text(`Ano: ${anoSelecionado}`, 20, yPos);
        pdf.text(`Modalidade: ${modalidadeSelecionada === 'Tudo' ? 'Todas as Modalidades' : modalidadeSelecionada}`, 20, yPos + 7);
        yPos += 15;
        
        // Converter canvas para imagem
        const canvas = document.getElementById('barChart');
        const imgData = canvas.toDataURL('image/png');
        
        // Calcular dimensÃµes da imagem (ajustar para caber bem)
        const imgWidth = 240;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        
        // Adicionar imagem do grÃ¡fico ao PDF
        pdf.addImage(imgData, 'PNG', 20, yPos, imgWidth, imgHeight);
        yPos += imgHeight + 15;
        
        // Adicionar seÃ§Ã£o de relatÃ³rio textual
        pdf.setFontSize(14);
        pdf.setFont(undefined, 'bold');
        pdf.text('Resumo EstatÃ­stico', 20, yPos);
        yPos += 8;
        
        pdf.setFontSize(11);
        pdf.setFont(undefined, 'normal');
        
        // Total de exames
        pdf.setFont(undefined, 'bold');
        pdf.text(`Total de Exames: ${totalExames}`, 20, yPos);
        yPos += 7;
        
        // Por modalidade (se filtro = "Tudo")
        if (modalidadeSelecionada === 'Tudo') {
            pdf.setFont(undefined, 'bold');
            pdf.text('Por Modalidade:', 20, yPos);
            yPos += 7;
            pdf.setFont(undefined, 'normal');
            
            const modalidadesOrdenadas = Object.keys(totalPorModalidade).sort();
            modalidadesOrdenadas.forEach(modalidade => {
                const quantidade = totalPorModalidade[modalidade];
                pdf.text(`  â€¢ ${modalidade}: ${quantidade}`, 25, yPos);
                yPos += 6;
                
                // Quebra de pÃ¡gina se necessÃ¡rio
                if (yPos > 180) {
                    pdf.addPage();
                    yPos = 20;
                }
            });
        }
        
        // Por mês
        yPos += 3;
        pdf.setFont(undefined, 'bold');
        pdf.text('Por Mês:', 20, yPos);
        yPos += 7;
        pdf.setFont(undefined, 'normal');
        
        meses.forEach(mes => {
            const quantidade = dadosPorMes[mes] || 0;
            pdf.text(`  • ${mes}: ${quantidade}`, 25, yPos);
            yPos += 6;
            
            // Quebra de pÃ¡gina se necessÃ¡rio
            if (yPos > 180) {
                pdf.addPage();
                yPos = 20;
            }
        });
        
        // Adicionar data/hora de geraÃ§Ã£o no rodapÃ©
        const dataHora = new Date().toLocaleString('pt-BR');
        pdf.setFontSize(8);
        pdf.setFont(undefined, 'italic');
        pdf.text(`RelatÃ³rio gerado em: ${dataHora}`, 20, 195, { align: 'left' });
        
        // Salvar PDF
        const nomeModalidade = modalidadeSelecionada === 'Tudo' ? 'Todas' : modalidadeSelecionada.replace(/\s+/g, '_');
        const fileName = `relatorio_exames_${anoSelecionado}_${nomeModalidade}.pdf`;
        pdf.save(fileName);
        
    } catch (error) {
        console.error('Erro ao exportar PDF:', error);
        alert('Erro ao exportar PDF. Verifique se a biblioteca jsPDF estÃ¡ carregada.\n\nErro: ' + error.message);
    }
}

// FunÃ§Ã£o para abrir o modal de grÃ¡fico
function abrirModalGrafico() {
    const modal = document.getElementById('modalGrafico');
    if (!modal) {
        console.error('Modal de grÃ¡fico nÃ£o encontrado');
        return;
    }
    
    // Verificar se Chart.js estÃ¡ disponÃ­vel
    if (typeof Chart === 'undefined') {
        alert('Erro: Chart.js nÃ£o estÃ¡ carregado. Verifique a conexÃ£o com a internet.');
        return;
    }
    
    // Adicionar listener para fechar ao clicar fora (apenas uma vez)
    if (!modal.hasAttribute('data-click-handler')) {
        modal.setAttribute('data-click-handler', 'true');
        modal.addEventListener('click', function(e) {
            // Fechar apenas se clicar no overlay (fora do conteÃºdo)
            if (e.target === modal) {
                window.fecharModalGrafico();
            }
        });
    }
    
    modal.style.display = 'flex';
    setTimeout(() => {
        modal.classList.add('show');
        // Aguardar um pouco mais para garantir que o modal estÃ¡ totalmente visÃ­vel
        setTimeout(() => {
            inicializarDropdowns();
            atualizarGrafico();
        }, 100);
    }, 10);
}

// Atualizar a funÃ§Ã£o que abre o modal para inicializar os dropdowns
// Aguardar o DOM estar pronto e depois configurar o botÃ£o de relatÃ³rio
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', configurarBotaoRelatorio);
} else {
    // DOM jÃ¡ estÃ¡ pronto
    setTimeout(configurarBotaoRelatorio, 100);
}

function configurarBotaoRelatorio() {
    const relatorioBtn = document.getElementById('relatorio');
    if (relatorioBtn && !relatorioBtn.hasAttribute('data-initialized')) {
        relatorioBtn.setAttribute('data-initialized', 'true');
        relatorioBtn.addEventListener('click', function(e) {
            e.preventDefault();
            abrirModalGrafico();
        });
    }
}

// Exportar funÃ§Ãµes necessÃ¡rias
module.exports = {
    salvarExame,
    abrirModal,
    carregarMaisRegistros: () => {
        paginaAtual++;
        atualizarTabela();
    }
};
