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

let ocorrencias = [];
let ocorrenciaSelecionada = null;
let ocorrenciasFiltradas = [];
let registrosPorPagina = 50;
let paginaAtual = 1;
let registroAtualId = null;
let dataVersionOcorrencias = 0;

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

function calcularPrazoEfetivo(ocorrencia) {
    const prazoDireto = toIsoDateOnly(ocorrencia?.prazo || '');
    if (prazoDireto) return prazoDireto;
    const dataBase = toIsoDateOnly(ocorrencia?.data || '');
    if (!dataBase) return '';

    const base = new Date(`${dataBase}T00:00:00`);
    if (Number.isNaN(base.getTime())) return '';
    const prioridade = normalizarPrioridade(ocorrencia?.prioridade);
    const dias = prioridade === 'Alta' ? 1 : (prioridade === 'Baixa' ? 5 : 3);
    base.setDate(base.getDate() + dias);
    return base.toISOString().slice(0, 10);
}

function calcularSla(ocorrencia) {
    const statusNorm = obterStatusNormalizado(ocorrencia?.status);
    if (statusNorm === 'concluido') return 'Concluida';
    const prazo = calcularPrazoEfetivo(ocorrencia);
    if (!prazo) return 'Sem prazo';

    const hoje = new Date();
    const hojeLocal = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
    const hojeIso = hojeLocal.toISOString().slice(0, 10);
    if (prazo < hojeIso) return 'Atrasada';
    if (prazo === hojeIso) return 'Vence hoje';
    return 'No prazo';
}

// Função para aplicar tema (definida no início para garantir que seja executada primeiro)
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
            const savedTheme = localStorage.getItem('theme') || 'light';
            setTheme(savedTheme);
        }
    } catch (error) {
        console.error('Erro ao carregar tema:', error);
    }
}

// Executar carregamento do tema imediatamente (quando o script é carregado)
// O tema já foi aplicado no HTML, mas vamos garantir que está correto
loadTheme();

// Funções de Inicialização
document.addEventListener('DOMContentLoaded', async () => {
    await garantirAcesso(['admin', 'recepcao', 'tecnico']);
    // Carregar tema novamente para garantir
    loadTheme();
    
    await carregarOcorrencias();
    setupEventListeners();
    aplicarFiltroInicialPorUrl();
    atualizarTabela();
    atualizarBotoesAcao();
});

function obterStatusNormalizado(valor) {
    return String(valor || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}

function aplicarFiltroInicialPorUrl() {
    try {
        const params = new URLSearchParams(window.location.search);
        const pendenciaId = String(params.get('pendencia_id') || '').trim();
        if (!pendenciaId) return;

        const alvo = ocorrencias.find((o) => String(o?.id ?? '') === pendenciaId);
        if (!alvo) return;

        const pendentes = ocorrencias.filter((o) => obterStatusNormalizado(o?.status) !== 'concluido');
        ocorrenciasFiltradas = pendentes.length > 0 ? pendentes : [...ocorrencias];
        paginaAtual = 1;
        ocorrenciaSelecionada = alvo;

        const inputPesquisa = document.getElementById('inputPesquisa');
        if (inputPesquisa) {
            inputPesquisa.value = String(alvo.descricao || alvo.responsavel || '').slice(0, 80);
        }
    } catch (error) {
        console.error('Erro ao aplicar filtro inicial por URL:', error);
    }
}

async function carregarOcorrencias() {
    ocorrencias = await ipcRenderer.invoke('ler-ocorrencias');
    ocorrencias = (Array.isArray(ocorrencias) ? ocorrencias : []).map((item) => ({
        ...item,
        prioridade: normalizarPrioridade(item?.prioridade),
        prazo: toIsoDateOnly(item?.prazo || '')
    }));
    const v = await ipcRenderer.invoke('data-get-version', 'ocorrencias');
    dataVersionOcorrencias = Number(v?.version || 0);
    ocorrenciasFiltradas = [...ocorrencias];
    atualizarTabela();
}

async function salvarOcorrencias() {
    const ok = await ipcRenderer.invoke('salvar-ocorrencias', {
        data: ocorrencias,
        expectedVersion: dataVersionOcorrencias,
        detalhe: 'Atualizacao via modulo de ocorrencias'
    });
    if (!ok) {
        throw new Error('Falha ao salvar ocorrências (possível conflito).');
    }
    const v = await ipcRenderer.invoke('data-get-version', 'ocorrencias');
    dataVersionOcorrencias = Number(v?.version || dataVersionOcorrencias);
}

// Funções para o Modal de Alerta
function mostrarAlerta(mensagem) {
    const modal = document.getElementById('modalAlerta');
    document.getElementById('mensagemAlerta').textContent = mensagem;
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('show'), 10);
}

function fecharModalAlerta() {
    const modal = document.getElementById('modalAlerta');
    modal.classList.remove('show');
    setTimeout(() => modal.style.display = 'none', 300);
}

window.salvarOcorrencia = async function(event) {
    event.preventDefault(); // Previne o envio do formulário
    const form = document.getElementById('formOcorrencia');
    
    if (!form.checkValidity()) {
        mostrarAlerta('Por favor, preencha todos os campos obrigatórios.');
        return;
    }

    const novaOcorrencia = {
        id: ocorrenciaSelecionada ? ocorrenciaSelecionada.id : Date.now(),
        data: form.data.value,
        turno: form.turno.value,
        descricao: form.descricao.value,
        responsavel: form.responsavel.value,
        prazo: toIsoDateOnly(form.prazo?.value || ''),
        prioridade: normalizarPrioridade(form.prioridade?.value || 'Media'),
        status: form.status.value
    };

    if (ocorrenciaSelecionada) {
        const index = ocorrencias.findIndex(r => r.id === ocorrenciaSelecionada.id);
        ocorrencias[index] = novaOcorrencia;
    } else {
        ocorrencias.unshift(novaOcorrencia);
    }

    try {
        await salvarOcorrencias();
    } catch (error) {
        mostrarAlerta(error.message || 'Erro ao salvar ocorrência.');
        await carregarOcorrencias();
        return;
    }
    ocorrenciasFiltradas = [...ocorrencias];
    ocorrenciaSelecionada = null;
    paginaAtual = 1;
    
    document.getElementById('modalForm').style.display = 'none'; // Fecha o modal
    atualizarTabela();
    atualizarBotoesAcao();
}

function criarLinhaTabela(ocorrencia) {
    const tr = document.createElement('tr');
    tr.dataset.id = ocorrencia.id.toString();
    const prazoExibicao = formatarData(calcularPrazoEfetivo(ocorrencia));
    const sla = calcularSla(ocorrencia);
    tr.innerHTML = `
        <td>${formatarData(ocorrencia.data)}</td>
        <td>${ocorrencia.turno}</td>
        <td>${ocorrencia.descricao}</td>
        <td>${ocorrencia.responsavel}</td>
        <td>${prazoExibicao}</td>
        <td>${ocorrencia.prioridade || 'Media'}</td>
        <td>${sla}</td>
        <td>${ocorrencia.status}</td>
    `;
    return tr;
}

function formatarData(data) {
    if (!data) return '';
    return new Date(data).toLocaleDateString('pt-BR');
}

function atualizarTabela() {
    const tbody = document.getElementById('listaExames');
    tbody.innerHTML = '';
    
    const inicio = 0;
    const fim = Math.min(registrosPorPagina * paginaAtual, ocorrenciasFiltradas.length);
    
    for (let i = inicio; i < fim; i++) {
        const ocorrencia = ocorrenciasFiltradas[i];
        const tr = criarLinhaTabela(ocorrencia);
        if (ocorrenciaSelecionada && ocorrencia.id === ocorrenciaSelecionada.id) {
            tr.classList.add('selected');
        }
        tbody.appendChild(tr);
    }
    atualizarResumoOcorrencias();
}

function atualizarResumoOcorrencias() {
    const info = document.getElementById('ocorrenciasInfo');
    const btnMais = document.getElementById('btnCarregarMaisOcorrencias');
    const total = ocorrenciasFiltradas.length;
    const exibidos = Math.min(registrosPorPagina * paginaAtual, total);
    if (info) info.textContent = `Exibindo ${exibidos} de ${total} ocorrências`;
    if (btnMais) btnMais.style.display = exibidos < total ? 'inline-flex' : 'none';
}

window.carregarMaisOcorrencias = function() {
    paginaAtual += 1;
    atualizarTabela();
}

// Funções de UI
window.abrirModal = function(tipo) {
    const form = document.getElementById('formOcorrencia');
    const modal = document.getElementById('modalForm');
    
    if (tipo === 'novo') {
        form.reset();
        document.getElementById('modalTitle').textContent = 'Nova Ocorrência';
    } else if (tipo === 'editar' && ocorrenciaSelecionada) {
        form.data.value = ocorrenciaSelecionada.data;
        form.turno.value = ocorrenciaSelecionada.turno;
        form.descricao.value = ocorrenciaSelecionada.descricao;
        form.responsavel.value = ocorrenciaSelecionada.responsavel;
        form.prazo.value = toIsoDateOnly(ocorrenciaSelecionada.prazo || '');
        form.prioridade.value = normalizarPrioridade(ocorrenciaSelecionada.prioridade || 'Media');
        form.status.value = ocorrenciaSelecionada.status;
        document.getElementById('modalTitle').textContent = 'Editar Ocorrência';
    }
    
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('show'), 10); // Adiciona animação
}

window.fecharModal = function() {
    const modal = document.getElementById('modalForm');
    modal.classList.remove('show');
    setTimeout(() => modal.style.display = 'none', 300); // Espera a animação terminar
}

function atualizarBotoesAcao() {
    document.getElementById('btnEditarRegistro').disabled = !ocorrenciaSelecionada;
    document.getElementById('btnExcluirRegistro').disabled = !ocorrenciaSelecionada;
}

// Funções para o Modal de Confirmação
function mostrarModalConfirmacao() {
    const modal = document.getElementById('modalConfirmacao');
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('show'), 10);
}

function fecharModalConfirmacao() {
    const modal = document.getElementById('modalConfirmacao');
    modal.classList.remove('show');
    setTimeout(() => modal.style.display = 'none', 300);
}

function confirmarExclusao() {
    if (!ocorrenciaSelecionada) return;
    
    const index = ocorrencias.findIndex(o => o.id === ocorrenciaSelecionada.id);
    if (index !== -1) {
        ocorrencias.splice(index, 1);
        ocorrenciasFiltradas = [...ocorrencias];
        salvarOcorrencias().catch(async (error) => {
            mostrarAlerta(error.message || 'Erro ao excluir ocorrência.');
            await carregarOcorrencias();
        });
        ocorrenciaSelecionada = null;
        atualizarTabela();
        atualizarBotoesAcao();
        fecharModalConfirmacao();
    }
}

// Função para filtrar ocorrências
window.filtrarOcorrencias = function() {
    const termoPesquisa = document.getElementById('inputPesquisa').value.toLowerCase();
    
    ocorrenciasFiltradas = ocorrencias.filter(ocorrencia => {
        return (
            ocorrencia.data.toLowerCase().includes(termoPesquisa) ||
            ocorrencia.turno.toLowerCase().includes(termoPesquisa) ||
            ocorrencia.descricao.toLowerCase().includes(termoPesquisa) ||
            ocorrencia.responsavel.toLowerCase().includes(termoPesquisa) ||
            String(ocorrencia.prazo || '').toLowerCase().includes(termoPesquisa) ||
            String(ocorrencia.prioridade || '').toLowerCase().includes(termoPesquisa) ||
            calcularSla(ocorrencia).toLowerCase().includes(termoPesquisa) ||
            ocorrencia.status.toLowerCase().includes(termoPesquisa)
        );
    });
    
    paginaAtual = 1;
    atualizarTabela();
}

// Função para limpar pesquisa
window.limparPesquisa = function() {
    const input = document.getElementById('inputPesquisa');
    input.value = '';
    ocorrenciasFiltradas = [...ocorrencias];
    paginaAtual = 1;
    atualizarTabela();
    document.querySelector('.clear-search').style.display = 'none';
}

// Adicione estas funções para manipulação do modal de observações
function abrirModalObservacoes(ocorrencia) {
    const modal = document.getElementById('modalObservacoes');
    document.getElementById('observacoesAdicionais').value = ocorrencia.descricao || '';
    registroAtualId = ocorrencia.id;
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('show'), 10);
}

function fecharModalObservacoes() {
    const modal = document.getElementById('modalObservacoes');
    modal.classList.remove('show');
    setTimeout(() => {
        modal.style.display = 'none';
        registroAtualId = null;
    }, 300);
}

function salvarObservacoes() {
    if (!registroAtualId) return;
    
    const descricao = document.getElementById('observacoesAdicionais').value;
    const index = ocorrencias.findIndex(r => r.id === registroAtualId);
    
    if (index !== -1) {
        ocorrencias[index].descricao = descricao;
        salvarOcorrencias().catch(async (error) => {
            mostrarAlerta(error.message || 'Erro ao salvar observações.');
            await carregarOcorrencias();
        });
        atualizarTabela();
        fecharModalObservacoes();
    }
}

function setupEventListeners() {
    // Carregar tema
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
    
    // Evento de clique nas linhas da tabela
    document.getElementById('listaExames').addEventListener('click', (event) => {
        const tr = event.target.closest('tr');
        if (!tr) return;
        
        const id = parseInt(tr.dataset.id);
        const ocorrencia = ocorrencias.find(o => o.id === id);
        
        document.querySelectorAll('tr.selected').forEach(row => row.classList.remove('selected'));
        
        if (ocorrenciaSelecionada && ocorrenciaSelecionada.id === id) {
            ocorrenciaSelecionada = null;
        } else {
            tr.classList.add('selected');
            ocorrenciaSelecionada = ocorrencia;
        }
        
        atualizarBotoesAcao();
    });

    // Evento para exclusão
    document.getElementById('btnExcluirRegistro').addEventListener('click', () => {
        if (!ocorrenciaSelecionada) {
            mostrarAlerta('Selecione uma ocorrência para excluir.');
            return;
        }
        mostrarModalConfirmacao();
    });

    // Adicionar evento para limpar pesquisa quando o campo estiver vazio
    document.getElementById('inputPesquisa').addEventListener('input', (event) => {
        if (event.target.value === '') {
            ocorrenciasFiltradas = [...ocorrencias];
            paginaAtual = 1;
            atualizarTabela();
        }
    });

    // Atualizar o listener de input para mostrar/esconder o botão de limpar
    document.getElementById('inputPesquisa').addEventListener('input', function(event) {
        const clearButton = document.querySelector('.clear-search');
        clearButton.style.display = event.target.value ? 'flex' : 'none';
    });

    // Adicionar evento de duplo clique nas linhas da tabela
    document.getElementById('listaExames').addEventListener('dblclick', (event) => {
        const tr = event.target.closest('tr');
        if (!tr || !tr.dataset.id) return;
        
        const id = parseInt(tr.dataset.id);
        const ocorrencia = ocorrencias.find(o => o.id === id);
        if (ocorrencia) {
            abrirModalObservacoes(ocorrencia);
        }
    });

    // Adicionar evento de clique nos cabeçalhos da tabela
    document.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => ordenarTabela(th));
    });
}

// Adicione a função de ordenação
function ordenarTabela(th) {
    const colunas = ['data', 'turno', 'descricao', 'responsavel', 'prazo', 'prioridade', 'sla', 'status'];
    const coluna = colunas[Array.from(th.parentElement.children).indexOf(th)];
    const direcaoAtual = th.dataset.sort;
    
    // Limpa direção de ordenação de todas as colunas
    document.querySelectorAll('th[data-sort]').forEach(header => {
        header.dataset.sort = 'asc';
    });

    // Alterna a direção da coluna clicada
    const direcaoNova = direcaoAtual === 'asc' ? 'desc' : 'asc';
    th.dataset.sort = direcaoNova;

    ocorrenciasFiltradas.sort((a, b) => {
        let valorA = coluna === 'sla' ? calcularSla(a) : a[coluna];
        let valorB = coluna === 'sla' ? calcularSla(b) : b[coluna];

        if (coluna === 'data') {
            valorA = new Date(valorA);
            valorB = new Date(valorB);
        } else {
            valorA = String(valorA).toLowerCase();
            valorB = String(valorB).toLowerCase();
        }

        if (valorA < valorB) return direcaoNova === 'asc' ? -1 : 1;
        if (valorA > valorB) return direcaoNova === 'asc' ? 1 : -1;
        return 0;
    });

    atualizarTabela();
}

// Em caso de erros
function handleError(error) {
    console.error('Erro:', error);
    mostrarAlerta('Ocorreu um erro: ' + error.message);
}

// Função para gerenciar os temas
// Funções de tema já definidas no início do arquivo

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
