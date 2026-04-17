const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
require('dotenv').config();
const { MongoClient } = require('mongodb');
const marked = require('marked');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx-js-style'); // Altere esta linha
const { createClientPortalServer } = require('./src/scripts/clientPortalServer');

const appDataRoot = path.join(app.getPath('appData'), 'RegistroDePacientes');
const userDataPath = path.join(appDataRoot, 'user-data');
const sessionDataPath = path.join(appDataRoot, 'session-data');
app.setPath('userData', userDataPath);
app.setPath('sessionData', sessionDataPath);

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
    app.quit();
}

let mainWindow;
let helpWindow;
let mongoClient;
let mongoDb;

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const MONGO_DB_NAME = process.env.MONGODB_DB || 'registro_pacientes';
const APP_DATA_COLLECTION = 'app_data';
const DATA_TYPES = [
    'registros',
    'pacientes',
    'agendamentos',
    'medicos-agenda',
    'ocorrencias',
    'ponto',
    'config',
    'auth-presence',
    'audit-log',
    'data-meta',
    'chat-messages'
];
const MONGO_RECONNECT_INTERVAL_MS = 15000;
const AUTH_PRESENCE_HEARTBEAT_MS = 15000;
const AUTH_PRESENCE_TTL_MS = 45000;
const AUTH_PASSWORD_MIN_LENGTH = 8;
const AUTH_PASSWORD_MAX_ATTEMPTS = 5;
const AUTH_PASSWORD_LOCK_MINUTES = 15;
const AUTH_PASSWORD_MAX_AGE_DAYS = 90;
const AUTO_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_BACKUP_RETENTION = 30;
const AUTO_BACKUP_SINGLE_FILENAME = 'backup_auto_atual.json';
const CLIENT_PORTAL_HOST = process.env.CLIENT_PORTAL_HOST || process.env.HOST || '127.0.0.1';
const CLIENT_PORTAL_PORT = Number(process.env.CLIENT_PORTAL_PORT || 3210);

let mongoOnline = false;
let needsLocalSync = false;
let reconnectTimer = null;
let reconnectInProgress = false;
let currentSession = null;
let authPresenceTimer = null;
let autoBackupTimer = null;
let clientPortal = null;
let clientPortalServer = null;
const appInstanceId = `${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const authFailedAttempts = new Map();

const AUTH_ROLES = ['admin', 'recepcao', 'tecnico'];

// Adicionar nova funÃƒÆ’Ã‚Â§ÃƒÆ’Ã‚Â£o para gerenciar caminhos de arquivos
function getDataFilePath(tipo) {
    const dataDir = path.join(__dirname, 'data');
    switch(tipo) {
        case 'registros':
            return path.join(dataDir, 'registros.json');
        case 'agendamentos':
            return path.join(dataDir, 'agendamentos.json');
        case 'medicos-agenda':
            return path.join(dataDir, 'medicos_agenda.json');
        case 'ocorrencias':
            return path.join(dataDir, 'ocorrencias.json');
        case 'ponto':
            return path.join(dataDir, 'ponto.json');
        case 'config':
            return path.join(dataDir, 'config.json');
        case 'auth-presence':
            return path.join(dataDir, 'auth_presence.json');
        case 'audit-log':
            return path.join(dataDir, 'audit_log.json');
        case 'data-meta':
            return path.join(dataDir, 'data_meta.json');
        case 'chat-messages':
            return path.join(dataDir, 'chat_messages.json');
        case 'pacientes':
            return path.join(dataDir, 'pacientes.json');
        default:
            return path.join(dataDir, 'registros.json');
    }
}

function getChatUploadsDir() {
    return path.join(__dirname, 'data', 'chat_uploads');
}

const CHAT_ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.pdf']);

function getChatAttachmentMimeType(ext) {
    const normalized = String(ext || '').trim().toLowerCase();
    if (normalized === '.png') return 'image/png';
    if (normalized === '.jpg' || normalized === '.jpeg') return 'image/jpeg';
    if (normalized === '.pdf') return 'application/pdf';
    return 'application/octet-stream';
}

function isChatAttachmentImage(ext) {
    const normalized = String(ext || '').trim().toLowerCase();
    return normalized === '.png' || normalized === '.jpg' || normalized === '.jpeg';
}

function validarAttachmentChat(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const filePath = String(payload.path || '').trim();
    const name = String(payload.name || '').trim();
    const ext = path.extname(filePath || name).toLowerCase();
    if (!filePath || !name || !ext) {
        throw new Error('Anexo inválido.');
    }
    if (!CHAT_ALLOWED_EXTENSIONS.has(ext)) {
        throw new Error('Formato de arquivo não permitido. Use PNG, JPG ou PDF.');
    }
    if (!fs.existsSync(filePath)) {
        throw new Error('Arquivo do anexo não encontrado.');
    }
    const uploadsDir = path.resolve(getChatUploadsDir()) + path.sep;
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(uploadsDir)) {
        throw new Error('Origem do anexo inválida.');
    }
    const stats = fs.statSync(resolvedPath);
    if (!stats.isFile()) {
        throw new Error('Anexo inválido.');
    }
    return {
        name,
        path: resolvedPath,
        type: getChatAttachmentMimeType(ext),
        size: Number(stats.size || 0),
        extension: ext,
        kind: isChatAttachmentImage(ext) ? 'image' : 'pdf'
    };
}

function getDefaultValue(tipo) {
    if (tipo === 'ponto') {
        return { funcionarios: [], registros: [] };
    }
    if (tipo === 'config') {
        return {};
    }
    if (tipo === 'auth-presence') {
        return [];
    }
    if (tipo === 'audit-log') {
        return [];
    }
    if (tipo === 'data-meta') {
        return { versions: {} };
    }
    if (tipo === 'chat-messages') {
        return [];
    }
    return [];
}

function cloneDefaultValue(tipo) {
    const value = getDefaultValue(tipo);
    return JSON.parse(JSON.stringify(value));
}

function parseJsonSafe(raw, fallbackValue) {
    try {
        return JSON.parse((raw || '').replace(/^\uFEFF/, ''));
    } catch (error) {
        return fallbackValue;
    }
}

function lerDoArquivoLocal(tipo) {
    const filePath = getDataFilePath(tipo);
    const fallback = cloneDefaultValue(tipo);

    if (!fs.existsSync(filePath)) {
        return fallback;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    return parseJsonSafe(raw, fallback);
}

function salvarNoArquivoLocal(tipo, payload) {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const filePath = getDataFilePath(tipo);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

async function connectMongo() {
    if (mongoDb) {
        return mongoDb;
    }

    if (mongoClient) {
        try {
            await mongoClient.close();
        } catch (error) {
            console.warn('Falha ao fechar cliente MongoDB anterior:', error.message);
        }
    }

    mongoClient = new MongoClient(MONGO_URI, {
        serverSelectionTimeoutMS: 5000
    });

    await mongoClient.connect();
    mongoDb = mongoClient.db(MONGO_DB_NAME);
    mongoOnline = true;
    return mongoDb;
}

function getCollection() {
    if (!mongoDb) {
        throw new Error('MongoDB nao inicializado');
    }
    return mongoDb.collection(APP_DATA_COLLECTION);
}

async function lerDoBanco(tipo) {
    const collection = getCollection();
    const doc = await collection.findOne({ _id: tipo });
    if (!doc || doc.payload === undefined || doc.payload === null) {
        return cloneDefaultValue(tipo);
    }
    return doc.payload;
}

async function salvarNoBanco(tipo, payload) {
    const collection = getCollection();
    await collection.updateOne(
        { _id: tipo },
        {
            $set: {
                payload,
                updatedAt: new Date()
            },
            $setOnInsert: {
                createdAt: new Date()
            }
        },
        { upsert: true }
    );
}

function marcarMongoOffline(contexto, error) {
    if (mongoOnline) {
        console.warn(`MongoDB offline (${contexto}):`, error.message);
    }
    mongoOnline = false;
    mongoDb = null;
}

async function sincronizarLocalParaMongo() {
    for (const tipo of DATA_TYPES) {
        const payload = lerDoArquivoLocal(tipo);
        await salvarNoBanco(tipo, payload);
    }
    needsLocalSync = false;
}

async function migrarJsonLegadoParaMongo() {
    const collection = getCollection();

    for (const tipo of DATA_TYPES) {
        const existe = await collection.findOne({ _id: tipo }, { projection: { _id: 1 } });
        if (existe) {
            continue;
        }

        const payload = lerDoArquivoLocal(tipo);

        await salvarNoBanco(tipo, payload);
    }
}

async function lerDados(tipo) {
    if (mongoOnline) {
        try {
            const payload = await lerDoBanco(tipo);
            salvarNoArquivoLocal(tipo, payload);
            return payload;
        } catch (error) {
            marcarMongoOffline(`leitura de ${tipo}`, error);
        }
    }

    return lerDoArquivoLocal(tipo);
}

async function salvarDados(tipo, payload) {
    salvarNoArquivoLocal(tipo, payload);

    if (mongoOnline) {
        try {
            await salvarNoBanco(tipo, payload);
            return;
        } catch (error) {
            needsLocalSync = true;
            marcarMongoOffline(`gravacao de ${tipo}`, error);
            return;
        }
    }

    needsLocalSync = true;
}

async function manterConexaoMongo() {
    if (reconnectInProgress) {
        return;
    }

    reconnectInProgress = true;
    try {
        if (mongoOnline && mongoDb) {
            await mongoDb.command({ ping: 1 });
            return;
        }

        await connectMongo();
        console.log('MongoDB reconectado.');
        await migrarJsonLegadoParaMongo();

        if (needsLocalSync) {
            await sincronizarLocalParaMongo();
            console.log('Sincronizacao local -> MongoDB concluida.');
        }
    } catch (error) {
        marcarMongoOffline('reconexao automatica', error);
    } finally {
        reconnectInProgress = false;
    }
}

function iniciarLoopReconexaoMongo() {
    if (reconnectTimer) {
        return;
    }

    reconnectTimer = setInterval(() => {
        manterConexaoMongo().catch((error) => {
            console.error('Erro no loop de reconexao MongoDB:', error);
        });
    }, MONGO_RECONNECT_INTERVAL_MS);
}

async function inicializarPersistencia() {
    try {
        await connectMongo();
        await migrarJsonLegadoParaMongo();
        mongoOnline = true;
        return true;
    } catch (error) {
        marcarMongoOffline('inicializacao', error);
        needsLocalSync = true;
        return false;
    } finally {
        iniciarLoopReconexaoMongo();
    }
}

function cpfSomenteDigitos(valor) {
    return String(valor || '').replace(/\D/g, '');
}

function normalizarProntuario(valor) {
    return String(valor || '').trim().toUpperCase();
}

function extrairIdentificadoresPaciente(item) {
    const prontuario = normalizarProntuario(item?.prontuarioPaciente || item?.documentoPaciente || '');
    const cpf = cpfSomenteDigitos(item?.cpfPaciente || '');
    return { prontuario, cpf };
}

function extrairIdentificadoresRegistro(item) {
    const prontuario = normalizarProntuario(item?.prontuarioPaciente || item?.documentoPaciente || item?.pacienteDocumento || '');
    const cpf = cpfSomenteDigitos(item?.cpfPaciente || '');
    return { prontuario, cpf };
}

function identificarPaciente(item) {
    const { prontuario, cpf } = extrairIdentificadoresPaciente(item);
    if (prontuario) {
        return `prontuario:${prontuario}`;
    }
    if (cpf) {
        return `cpf:${cpf}`;
    }

    const id = item?.id !== undefined && item?.id !== null ? String(item.id) : '';
    if (id) {
        return `id:${id}`;
    }
    return '';
}

function validarDuplicidadePacientes(pacientes) {
    if (!Array.isArray(pacientes)) {
        throw new Error('Dados de pacientes invalidos.');
    }

    const porProntuario = new Map();
    const porCpf = new Map();

    for (let i = 0; i < pacientes.length; i += 1) {
        const paciente = pacientes[i];
        const { prontuario, cpf } = extrairIdentificadoresPaciente(paciente);
        const chavePaciente = identificarPaciente(paciente) || `anon:${i}`;

        if (prontuario) {
            const dono = porProntuario.get(prontuario);
            if (dono && dono !== chavePaciente) {
                throw new Error(`Duplicidade de paciente: prontuario ${prontuario} ja cadastrado.`);
            }
            porProntuario.set(prontuario, chavePaciente);
        }

        if (cpf) {
            const dono = porCpf.get(cpf);
            if (dono && dono !== chavePaciente) {
                throw new Error(`Duplicidade de paciente: CPF ${cpf} ja cadastrado.`);
            }
            porCpf.set(cpf, chavePaciente);
        }
    }
}

function validarDuplicidadeRegistros(registros) {
    if (!Array.isArray(registros)) {
        throw new Error('Dados de registros invalidos.');
    }

    const cpfPorProntuario = new Map();
    const prontuarioPorCpf = new Map();

    for (const registro of registros) {
        const { prontuario, cpf } = extrairIdentificadoresRegistro(registro);

        if (prontuario && cpf) {
            const cpfConhecido = cpfPorProntuario.get(prontuario);
            if (cpfConhecido && cpfConhecido !== cpf) {
                throw new Error(`Conflito de dados: prontuario ${prontuario} vinculado a CPF diferente.`);
            }
            cpfPorProntuario.set(prontuario, cpf);

            const prontuarioConhecido = prontuarioPorCpf.get(cpf);
            if (prontuarioConhecido && prontuarioConhecido !== prontuario) {
                throw new Error(`Conflito de dados: CPF ${cpf} vinculado a prontuario diferente.`);
            }
            prontuarioPorCpf.set(cpf, prontuario);
        }
    }
}

async function obterPacientesMongoOuVazio() {
    if (!mongoOnline) {
        return [];
    }

    try {
        const pacientes = await lerDoBanco('pacientes');
        return Array.isArray(pacientes) ? pacientes : [];
    } catch (error) {
        marcarMongoOffline('validacao de duplicidade', error);
        return [];
    }
}

async function validarDuplicidadeGlobalPacientes(pacientesEntrada, registrosEntrada = null) {
    const pacientesLocal = lerDoArquivoLocal('pacientes');
    const pacientesMongo = await obterPacientesMongoOuVazio();
    const pacientesBase = [
        ...pacientesLocal,
        ...pacientesMongo,
        ...(Array.isArray(pacientesEntrada) ? pacientesEntrada : [])
    ];

    if (Array.isArray(registrosEntrada)) {
        for (const registro of registrosEntrada) {
            const { prontuario, cpf } = extrairIdentificadoresRegistro(registro);
            if (!prontuario && !cpf) {
                continue;
            }

            pacientesBase.push({
                id: '',
                prontuarioPaciente: prontuario,
                cpfPaciente: cpf,
                documentoPaciente: prontuario
            });
        }
    }

    validarDuplicidadePacientes(pacientesBase);
}

function normalizarTextoBusca(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function montarDocumentoBusca(item) {
    const prontuario = normalizarProntuario(item?.prontuarioPaciente || item?.documentoPaciente || item?.pacienteDocumento || '');
    const cpf = cpfSomenteDigitos(item?.cpfPaciente || '');
    const numeroAcesso = String(item?.numeroAcesso || '').trim();
    const nomePaciente = String(item?.nomePaciente || '').trim();
    const modalidade = String(item?.modalidade || '').trim();
    const exame = String(item?.observacoes || item?.exame || '').trim();
    const tecnico = String(item?.nomeTecnico || '').trim();

    return normalizarTextoBusca([
        nomePaciente,
        cpf,
        prontuario,
        numeroAcesso,
        modalidade,
        exame,
        tecnico
    ].join(' '));
}

function criarResultadoBusca(origem, item, rota) {
    const prontuario = normalizarProntuario(item?.prontuarioPaciente || item?.documentoPaciente || item?.pacienteDocumento || '');
    const cpf = cpfSomenteDigitos(item?.cpfPaciente || '');
    const numeroAcesso = String(item?.numeroAcesso || '').trim();
    const nomePaciente = String(item?.nomePaciente || '').trim();
    const dataHora = String(item?.dataHoraExame || item?.dataHora || '').trim();
    const exame = String(item?.observacoes || item?.exame || '').trim();

    return {
        origem,
        rota,
        id: item?.id ?? '',
        nomePaciente,
        cpfPaciente: cpf,
        prontuarioPaciente: prontuario,
        numeroAcesso,
        dataHora,
        exame
    };
}

function deduplicarResultadosBusca(resultados) {
    const vistos = new Set();
    const filtrados = [];

    for (const item of resultados) {
        const chave = [
            item.origem,
            item.id,
            item.nomePaciente,
            item.cpfPaciente,
            item.prontuarioPaciente,
            item.numeroAcesso
        ].join('|');

        if (vistos.has(chave)) {
            continue;
        }

        vistos.add(chave);
        filtrados.push(item);
    }

    return filtrados;
}

async function montarTimelinePaciente({ documento = '', nome = '' }) {
    const docNorm = normalizarProntuario(documento).toLowerCase();
    const cpfNorm = cpfSomenteDigitos(documento);
    const nomeNorm = normalizarTextoBusca(nome);

    const [pacientes, agendamentos, registros] = await Promise.all([
        lerDados('pacientes'),
        lerDados('agendamentos'),
        lerDados('registros')
    ]);

    const pacientesArray = Array.isArray(pacientes) ? pacientes : [];
    const agArray = Array.isArray(agendamentos) ? agendamentos : [];
    const regArray = Array.isArray(registros) ? registros : [];

    const matchPaciente = (item) => {
        const prontuario = normalizarProntuario(item?.prontuarioPaciente || item?.documentoPaciente || item?.pacienteDocumento || '').toLowerCase();
        const cpf = cpfSomenteDigitos(item?.cpfPaciente || '');
        const nomeItem = normalizarTextoBusca(item?.nomePaciente || '');
        const porDoc = docNorm && prontuario && prontuario === docNorm;
        const porCpf = cpfNorm && cpf && cpf === cpfNorm;
        const porNome = !docNorm && !cpfNorm && nomeNorm && nomeItem === nomeNorm;
        return porDoc || porCpf || porNome;
    };

    const histAg = agArray
        .filter(matchPaciente)
        .map((a) => ({
            origem: 'Agendamento',
            data: String(a?.dataHora || ''),
            status: String(a?.statusExame || ''),
            modalidade: String(a?.modalidade || ''),
            exame: String(a?.exame || ''),
            tecnico: String(a?.nomeTecnico || ''),
            acesso: String(a?.numeroAcesso || '')
        }));

    const histReg = regArray
        .filter(matchPaciente)
        .map((r) => ({
            origem: 'Registro',
            data: String(r?.dataHoraExame || ''),
            status: String(r?.statusExame || 'Realizado'),
            modalidade: String(r?.modalidade || ''),
            exame: String(r?.observacoes || ''),
            tecnico: String(r?.nomeTecnico || ''),
            acesso: String(r?.numeroAcesso || '')
        }));

    const timeline = [...histAg, ...histReg]
        .sort((a, b) => Date.parse(b.data || '') - Date.parse(a.data || ''));

    const paciente = pacientesArray.find(matchPaciente);
    const nomeExibicao = String(paciente?.nomePaciente || nome || 'Paciente');
    const documentoExibicao = String(
        paciente?.prontuarioPaciente ||
        paciente?.documentoPaciente ||
        paciente?.cpfPaciente ||
        documento ||
        ''
    );

    return {
        nomeExibicao,
        documentoExibicao,
        timeline
    };
}

function obterActorAuditoria() {
    return {
        username: currentSession?.username || 'system',
        role: currentSession?.role || 'system',
        nome: currentSession?.nome || 'Sistema',
        sessionId: currentSession?.id || ''
    };
}

function descreverMudancaColecao(antes, depois) {
    const listaAntes = Array.isArray(antes) ? antes : [];
    const listaDepois = Array.isArray(depois) ? depois : [];
    const idsAntes = new Set(listaAntes.map((item) => String(item?.id ?? '')));
    const idsDepois = new Set(listaDepois.map((item) => String(item?.id ?? '')));

    let adicionados = 0;
    let removidos = 0;
    idsDepois.forEach((id) => {
        if (id && !idsAntes.has(id)) adicionados += 1;
    });
    idsAntes.forEach((id) => {
        if (id && !idsDepois.has(id)) removidos += 1;
    });

    return {
        totalAntes: listaAntes.length,
        totalDepois: listaDepois.length,
        adicionados,
        removidos
    };
}

async function registrarAuditoria({ acao, tipo, antes, depois, detalhe = '' }) {
    try {
        const atual = await lerDados('audit-log');
        const lista = Array.isArray(atual) ? atual : [];
        const actor = obterActorAuditoria();
        lista.push({
            id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
            at: new Date().toISOString(),
            acao: String(acao || 'update'),
            tipo: String(tipo || ''),
            actor,
            resumo: descreverMudancaColecao(antes, depois),
            detalhe: String(detalhe || '').slice(0, 400)
        });
        const limite = 5000;
        const final = lista.length > limite ? lista.slice(lista.length - limite) : lista;
        await salvarDados('audit-log', final);
    } catch (error) {
        console.warn('Falha ao registrar auditoria:', error.message);
    }
}

function normalizarDataMeta(meta) {
    const base = (meta && typeof meta === 'object') ? meta : {};
    const versions = (base.versions && typeof base.versions === 'object') ? base.versions : {};
    return { ...base, versions };
}

async function obterVersaoTipo(tipo) {
    const metaRaw = await lerDados('data-meta');
    const meta = normalizarDataMeta(metaRaw);
    return Number(meta.versions?.[tipo] || 0);
}

async function incrementarVersaoTipo(tipo) {
    const metaRaw = await lerDados('data-meta');
    const meta = normalizarDataMeta(metaRaw);
    const atual = Number(meta.versions?.[tipo] || 0);
    const proxima = atual + 1;
    meta.versions[tipo] = proxima;
    await salvarDados('data-meta', meta);
    return proxima;
}

function normalizarPayloadSalvar(input) {
    if (input && typeof input === 'object' && !Array.isArray(input) && Object.prototype.hasOwnProperty.call(input, 'data')) {
        return {
            data: input.data,
            expectedVersion: input.expectedVersion,
            detalhe: input.detalhe
        };
    }
    return {
        data: input,
        expectedVersion: null,
        detalhe: ''
    };
}

async function validarConcorrenciaOuFalhar(tipo, expectedVersion) {
    if (!Number.isFinite(Number(expectedVersion))) {
        return;
    }
    const atual = await obterVersaoTipo(tipo);
    const esperado = Number(expectedVersion);
    if (atual !== esperado) {
        throw new Error(`Conflito de atualizaÃ§Ã£o em ${tipo}. VersÃ£o atual: ${atual}. Recarregue a tela.`);
    }
}

function normalizarFiltroAuditoria(filtro) {
    const base = (filtro && typeof filtro === 'object') ? filtro : {};
    return {
        username: String(base.username || '').trim().toLowerCase(),
        acao: normalizarTextoBusca(base.acao || ''),
        tipo: normalizarTextoBusca(base.tipo || ''),
        dateFrom: String(base.dateFrom || '').slice(0, 10),
        dateTo: String(base.dateTo || '').slice(0, 10),
        search: normalizarTextoBusca(base.search || ''),
        limit: Math.max(1, Math.min(5000, Number(base.limit) || 200)),
        page: Math.max(1, Number(base.page) || 1),
        pageSize: Math.max(1, Math.min(200, Number(base.pageSize) || 20))
    };
}

function aplicarFiltroAuditoria(logs, filtroInput, options = {}) {
    const paginar = options.paginar !== false;
    const filtro = normalizarFiltroAuditoria(filtroInput);
    const lista = Array.isArray(logs) ? logs : [];

    const fromMs = filtro.dateFrom ? Date.parse(`${filtro.dateFrom}T00:00:00.000Z`) : NaN;
    const toMs = filtro.dateTo ? Date.parse(`${filtro.dateTo}T23:59:59.999Z`) : NaN;

    let filtrados = lista.filter((item) => {
        const actorUsername = String(item?.actor?.username || '').trim().toLowerCase();
        const acaoNorm = normalizarTextoBusca(item?.acao || '');
        const tipoNorm = normalizarTextoBusca(item?.tipo || '');
        const detalheNorm = normalizarTextoBusca(item?.detalhe || '');
        const actorNomeNorm = normalizarTextoBusca(item?.actor?.nome || '');
        const atMs = Date.parse(String(item?.at || ''));

        if (filtro.username && actorUsername !== filtro.username) return false;
        if (filtro.acao && !acaoNorm.includes(filtro.acao)) return false;
        if (filtro.tipo && !tipoNorm.includes(filtro.tipo)) return false;
        if (Number.isFinite(fromMs) && (!Number.isFinite(atMs) || atMs < fromMs)) return false;
        if (Number.isFinite(toMs) && (!Number.isFinite(atMs) || atMs > toMs)) return false;

        if (filtro.search) {
            const doc = normalizarTextoBusca([
                item?.id,
                item?.acao,
                item?.tipo,
                item?.detalhe,
                item?.actor?.username,
                item?.actor?.nome
            ].join(' '));
            if (!doc.includes(filtro.search) && !detalheNorm.includes(filtro.search) && !actorNomeNorm.includes(filtro.search)) {
                return false;
            }
        }

        return true;
    });

    filtrados = filtrados.sort((a, b) => Date.parse(String(b?.at || '')) - Date.parse(String(a?.at || '')));
    const total = filtrados.length;
    const totalPages = Math.max(1, Math.ceil(total / filtro.pageSize));
    const page = Math.min(filtro.page, totalPages);
    const start = (page - 1) * filtro.pageSize;
    const end = start + filtro.pageSize;
    const items = paginar
        ? filtrados.slice(start, end)
        : filtrados.slice(0, filtro.limit);

    return { items, total, filtro, page, pageSize: filtro.pageSize, totalPages };
}

function escaparCsv(valor) {
    const texto = String(valor ?? '');
    if (!/[",\n;]/.test(texto)) {
        return texto;
    }
    return `"${texto.replace(/"/g, '""')}"`;
}

function converterAuditoriaParaCsv(logs) {
    const cabecalho = [
        'id',
        'at',
        'username',
        'nome',
        'perfil',
        'acao',
        'tipo',
        'detalhe',
        'totalAntes',
        'totalDepois',
        'adicionados',
        'removidos'
    ];
    const linhas = [cabecalho.join(';')];
    const lista = Array.isArray(logs) ? logs : [];
    for (const item of lista) {
        const resumo = (item?.resumo && typeof item.resumo === 'object') ? item.resumo : {};
        const linha = [
            item?.id,
            item?.at,
            item?.actor?.username,
            item?.actor?.nome,
            item?.actor?.role,
            item?.acao,
            item?.tipo,
            item?.detalhe,
            resumo?.totalAntes ?? '',
            resumo?.totalDepois ?? '',
            resumo?.adicionados ?? '',
            resumo?.removidos ?? ''
        ].map(escaparCsv).join(';');
        linhas.push(linha);
    }
    return `${linhas.join('\n')}\n`;
}

const ACAO_POR_HANDLER = {
    'ler-registros': ['admin', 'recepcao', 'tecnico'],
    'salvar-registros': ['admin', 'recepcao', 'tecnico'],
    'ler-pacientes': ['admin', 'recepcao', 'tecnico'],
    'salvar-pacientes': ['admin', 'recepcao', 'tecnico'],
    'ler-agendamentos': ['admin', 'recepcao'],
    'salvar-agendamentos': ['admin', 'recepcao'],
    'ler-medicos-agenda': ['admin', 'recepcao'],
    'salvar-medicos-agenda': ['admin', 'recepcao'],
    'ler-ocorrencias': ['admin', 'recepcao', 'tecnico'],
    'salvar-ocorrencias': ['admin', 'recepcao', 'tecnico'],
    'ler-ponto': ['admin', 'recepcao', 'tecnico'],
    'salvar-ponto': ['admin', 'recepcao', 'tecnico'],
    'buscar-global': ['admin', 'recepcao', 'tecnico'],
    'salvar-arquivo': ['admin', 'recepcao'],
    'salvar-config': ['admin'],
    'set-theme': ['admin', 'recepcao', 'tecnico'],
    'get-theme': ['admin', 'recepcao', 'tecnico'],
    'importar-arquivo': ['admin', 'recepcao'],
    'exportar-pdf': ['admin', 'recepcao'],
    'exportar-csv': ['admin', 'recepcao'],
    'backup-list-auto': ['admin'],
    'backup-preview-auto': ['admin'],
    'backup-restore-auto': ['admin'],
    'dashboard-summary': ['admin'],
    'patient-timeline': ['admin', 'recepcao', 'tecnico'],
    'audit-list-user': ['admin'],
    'audit-export-user': ['admin'],
    'audit-query': ['admin'],
    'audit-export-csv': ['admin'],
    'chat-list': ['admin', 'recepcao', 'tecnico'],
    'chat-send': ['admin', 'recepcao', 'tecnico'],
    'chat-mark-read': ['admin', 'recepcao', 'tecnico'],
    'chat-users': ['admin', 'recepcao', 'tecnico'],
    'auth-list-online-users': ['admin', 'recepcao', 'tecnico'],
    'chat-delete-message': ['admin', 'recepcao', 'tecnico'],
    'chat-clear-conversation-self': ['admin', 'recepcao', 'tecnico'],
    'chat-delete-conversation-both': ['admin', 'recepcao', 'tecnico'],
    'chat-pick-file': ['admin', 'recepcao', 'tecnico'],
    'chat-open-file': ['admin', 'recepcao', 'tecnico']
};

function exigirPermissaoAcao(handlerName) {
    const permitidos = ACAO_POR_HANDLER[handlerName];
    if (!permitidos) return;
    if (!currentSession) {
        throw new Error('Sessao nao autenticada.');
    }
    const role = String(currentSession.role || '').toLowerCase();
    if (!permitidos.includes(role)) {
        throw new Error(`Permissao negada para ${handlerName}.`);
    }
}

function validarSenhaForteOuFalhar(senha) {
    const valor = String(senha || '');
    if (valor.length < AUTH_PASSWORD_MIN_LENGTH) {
        throw new Error(`A senha deve ter ao menos ${AUTH_PASSWORD_MIN_LENGTH} caracteres.`);
    }
    if (!/[A-Z]/.test(valor) || !/[a-z]/.test(valor) || !/\d/.test(valor) || !/[^A-Za-z0-9]/.test(valor)) {
        throw new Error('Senha fraca: use letras maiÃºsculas/minÃºsculas, nÃºmero e sÃ­mbolo.');
    }
}

function senhaExpirada(user) {
    const updatedAt = Date.parse(String(user?.passwordUpdatedAt || ''));
    if (!Number.isFinite(updatedAt)) return false;
    const idadeMs = Date.now() - updatedAt;
    return idadeMs > (AUTH_PASSWORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
}

function obterStatusTentativas(username) {
    const key = String(username || '').toLowerCase();
    const atual = authFailedAttempts.get(key) || { count: 0, lockedUntil: 0 };
    if (atual.lockedUntil && Date.now() > atual.lockedUntil) {
        authFailedAttempts.delete(key);
        return { count: 0, lockedUntil: 0 };
    }
    return atual;
}

function registrarFalhaLogin(username) {
    const key = String(username || '').toLowerCase();
    const atual = obterStatusTentativas(key);
    const proximo = { ...atual, count: atual.count + 1 };
    if (proximo.count >= AUTH_PASSWORD_MAX_ATTEMPTS) {
        proximo.lockedUntil = Date.now() + (AUTH_PASSWORD_LOCK_MINUTES * 60 * 1000);
    }
    authFailedAttempts.set(key, proximo);
    return proximo;
}

function limparTentativasLogin(username) {
    const key = String(username || '').toLowerCase();
    authFailedAttempts.delete(key);
}

function obterDiretorioAutoBackup() {
    return path.join(__dirname, 'data', 'backups', 'auto');
}

function obterCaminhoBackupAutomaticoUnico() {
    return path.join(obterDiretorioAutoBackup(), AUTO_BACKUP_SINGLE_FILENAME);
}

function normalizarBackupsAutoLegados(dir) {
    if (!fs.existsSync(dir)) {
        return;
    }
    const arquivosLegados = fs.readdirSync(dir)
        .filter((nome) => nome.startsWith('backup_auto_') && nome.endsWith('.json') && nome !== AUTO_BACKUP_SINGLE_FILENAME)
        .sort()
        .reverse();
    const destino = obterCaminhoBackupAutomaticoUnico();

    // Se nao existe backup unico, reaproveita o backup legado mais recente.
    if (!fs.existsSync(destino) && arquivosLegados.length > 0) {
        const maisRecente = arquivosLegados[0];
        try {
            fs.copyFileSync(path.join(dir, maisRecente), destino);
        } catch (error) {
            console.warn('Falha ao migrar backup legado para arquivo unico:', error.message);
        }
    }

    arquivosLegados.forEach((nome) => {
        try {
            fs.unlinkSync(path.join(dir, nome));
        } catch (error) {
            console.warn('Falha ao remover backup legado:', error.message);
        }
    });
}

async function criarBackupAutomatico() {
    const snapshot = {};
    for (const tipo of ['registros', 'pacientes', 'agendamentos', 'medicos-agenda', 'ocorrencias', 'ponto', 'config', 'chat-messages']) {
        snapshot[tipo] = await lerDados(tipo);
    }

    const dir = obterDiretorioAutoBackup();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    normalizarBackupsAutoLegados(dir);

    const filePath = obterCaminhoBackupAutomaticoUnico();
    fs.writeFileSync(filePath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        appInstanceId,
        snapshot
    }, null, 2), 'utf8');
}

function iniciarLoopBackupAutomatico() {
    if (autoBackupTimer) {
        return;
    }
    autoBackupTimer = setInterval(() => {
        criarBackupAutomatico().catch((error) => {
            console.warn('Falha no backup automatico:', error.message);
        });
    }, AUTO_BACKUP_INTERVAL_MS);
}

function listarBackupsAutomaticos() {
    const dir = obterDiretorioAutoBackup();
    if (!fs.existsSync(dir)) {
        return [];
    }
    normalizarBackupsAutoLegados(dir);
    const arquivoUnico = obterCaminhoBackupAutomaticoUnico();
    if (!fs.existsSync(arquivoUnico)) {
        return [];
    }
    return [{
        nome: AUTO_BACKUP_SINGLE_FILENAME,
        caminho: arquivoUnico,
        criadoEm: fs.statSync(arquivoUnico).mtime.toISOString()
    }];
}

async function restaurarBackupAutomatico(nomeArquivo) {
    const arquivos = listarBackupsAutomaticos();
    const alvo = arquivos.find((item) => item.nome === nomeArquivo);
    if (!alvo) {
        throw new Error('Backup automatico nao encontrado.');
    }
    const raw = fs.readFileSync(alvo.caminho, 'utf8');
    const parsed = JSON.parse(raw);
    const snapshot = parsed?.snapshot;
    if (!snapshot || typeof snapshot !== 'object') {
        throw new Error('Backup invalido: snapshot ausente.');
    }

    const tiposRestauraveis = ['registros', 'pacientes', 'agendamentos', 'medicos-agenda', 'ocorrencias', 'ponto', 'config', 'chat-messages'];
    for (const tipo of tiposRestauraveis) {
        if (!Object.prototype.hasOwnProperty.call(snapshot, tipo)) {
            continue;
        }
        await salvarDados(tipo, snapshot[tipo]);
        await incrementarVersaoTipo(tipo);
    }
    await registrarAuditoria({
        acao: 'restore-backup',
        tipo: 'sistema',
        antes: [],
        depois: [],
        detalhe: `Restauracao automatica a partir de ${nomeArquivo}`
    });
}

function construirResumoColecao(lista, dataFields = []) {
    const arr = Array.isArray(lista) ? lista : [];
    const datas = [];
    for (const item of arr) {
        for (const field of dataFields) {
            const raw = String(item?.[field] || '').trim();
            const parsed = Date.parse(raw);
            if (Number.isFinite(parsed)) {
                datas.push(parsed);
            }
        }
    }
    datas.sort((a, b) => a - b);
    return {
        total: arr.length,
        primeiraData: datas.length > 0 ? new Date(datas[0]).toISOString() : '',
        ultimaData: datas.length > 0 ? new Date(datas[datas.length - 1]).toISOString() : ''
    };
}

function obterPreviewBackupAutomatico(nomeArquivo) {
    const arquivos = listarBackupsAutomaticos();
    const alvo = arquivos.find((item) => item.nome === nomeArquivo);
    if (!alvo) {
        throw new Error('Backup automatico nao encontrado.');
    }
    const raw = fs.readFileSync(alvo.caminho, 'utf8');
    const parsed = JSON.parse(raw);
    const snapshot = parsed?.snapshot;
    if (!snapshot || typeof snapshot !== 'object') {
        throw new Error('Backup invalido: snapshot ausente.');
    }

    return {
        nome: alvo.nome,
        criadoEm: alvo.criadoEm,
        geradoEm: String(parsed?.generatedAt || ''),
        colecoes: {
            registros: construirResumoColecao(snapshot.registros, ['dataHoraExame']),
            pacientes: construirResumoColecao(snapshot.pacientes, ['createdAt', 'updatedAt']),
            agendamentos: construirResumoColecao(snapshot.agendamentos, ['dataHora']),
            'medicos-agenda': construirResumoColecao(snapshot['medicos-agenda'], []),
            ocorrencias: construirResumoColecao(snapshot.ocorrencias, ['data']),
            'chat-messages': construirResumoColecao(snapshot['chat-messages'], ['at']),
            ponto: {
                totalFuncionarios: Array.isArray(snapshot?.ponto?.funcionarios) ? snapshot.ponto.funcionarios.length : 0,
                totalRegistros: Array.isArray(snapshot?.ponto?.registros) ? snapshot.ponto.registros.length : 0
            }
        }
    };
}

function hashSenha(senha) {
    return crypto.createHash('sha256').update(String(senha || '')).digest('hex');
}

function normalizarRole(role) {
    const valor = String(role || '').trim().toLowerCase();
    return AUTH_ROLES.includes(valor) ? valor : 'recepcao';
}

function sanitizeAuthUser(user) {
    const passwordUpdatedAtRaw = String(user?.passwordUpdatedAt || '').trim();
    const passwordUpdatedAt = Number.isFinite(Date.parse(passwordUpdatedAtRaw))
        ? new Date(passwordUpdatedAtRaw).toISOString()
        : new Date().toISOString();
    return {
        id: String(user?.id || Date.now()),
        username: String(user?.username || '').trim().toLowerCase(),
        nome: String(user?.nome || user?.username || '').trim(),
        role: normalizarRole(user?.role),
        passwordHash: String(user?.passwordHash || ''),
        active: user?.active !== false,
        passwordUpdatedAt
    };
}

async function obterConfigAuth() {
    const config = await lerDados('config');
    const configSeguro = (config && typeof config === 'object') ? config : {};
    if (!Array.isArray(configSeguro.authUsers)) {
        configSeguro.authUsers = [];
    }
    return configSeguro;
}

function validarListaUsuarios(users) {
    if (!Array.isArray(users) || users.length === 0) {
        throw new Error('Lista de usuarios invalida.');
    }

    const usernames = new Set();
    let temAdmin = false;

    for (const item of users) {
        const user = sanitizeAuthUser(item);
        if (!user.username) {
            throw new Error('Usuario sem login.');
        }
        if (!user.passwordHash) {
            throw new Error(`Usuario ${user.username} sem senha.`);
        }
        if (usernames.has(user.username)) {
            throw new Error(`Usuario duplicado: ${user.username}.`);
        }
        usernames.add(user.username);
        if (user.role === 'admin' && user.active) {
            temAdmin = true;
        }
    }

    if (!temAdmin) {
        throw new Error('E necessario ao menos um usuario admin ativo.');
    }
}

async function garantirUsuariosAuth() {
    const config = await obterConfigAuth();
    if (config.authUsers.length > 0) {
        return config;
    }

    config.authUsers = [{
        id: 'admin-default',
        username: 'admin',
        nome: 'Administrador',
        role: 'admin',
        passwordHash: hashSenha('admin123'),
        active: true,
        passwordUpdatedAt: new Date().toISOString()
    }];
    await salvarDados('config', config);
    return config;
}

function montarSessao(user) {
    return {
        id: crypto.randomBytes(16).toString('hex'),
        username: user.username,
        nome: user.nome || user.username,
        role: normalizarRole(user.role),
        loginAt: new Date().toISOString()
    };
}

function obterSessaoAtual() {
    return currentSession ? { ...currentSession } : null;
}

function exigirAdmin() {
    if (!currentSession) {
        throw new Error('Sessao nao autenticada.');
    }
    if (currentSession.role !== 'admin') {
        throw new Error('Permissao negada. Requer perfil admin.');
    }
}

function toValidIsoDate(value, fallbackIso) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallbackIso;
}

function sanitizePresenceSession(session, fallbackIso) {
    return {
        id: String(session?.id || ''),
        username: String(session?.username || '').trim().toLowerCase(),
        nome: String(session?.nome || session?.username || '').trim(),
        role: normalizarRole(session?.role),
        loginAt: toValidIsoDate(session?.loginAt, fallbackIso)
    };
}

function sanitizePresenceEntry(item, fallbackIso) {
    const session = sanitizePresenceSession(item, fallbackIso);
    const lastSeen = toValidIsoDate(item?.lastSeen, fallbackIso);
    return {
        sessionId: session.id,
        username: session.username,
        nome: session.nome,
        role: session.role,
        loginAt: session.loginAt,
        lastSeen,
        hostname: String(item?.hostname || os.hostname()),
        appInstanceId: String(item?.appInstanceId || '')
    };
}

function filtrarPresencasAtivas(items) {
    const now = Date.now();
    const maxIdle = AUTH_PRESENCE_TTL_MS;
    const entries = Array.isArray(items) ? items : [];
    return entries
        .map((item) => sanitizePresenceEntry(item, new Date().toISOString()))
        .filter((entry) => entry.sessionId && entry.username)
        .filter((entry) => (now - Date.parse(entry.lastSeen)) <= maxIdle);
}

async function salvarPresencaSessaoAtual() {
    if (!currentSession?.id) {
        return;
    }

    const nowIso = new Date().toISOString();
    const safeSession = sanitizePresenceSession(currentSession, nowIso);
    const atuais = await lerDados('auth-presence');
    const ativos = filtrarPresencasAtivas(atuais);
    const semAtual = ativos.filter((item) => item.sessionId !== safeSession.id);

    semAtual.push({
        sessionId: safeSession.id,
        username: safeSession.username,
        nome: safeSession.nome,
        role: safeSession.role,
        loginAt: safeSession.loginAt,
        lastSeen: nowIso,
        hostname: os.hostname(),
        appInstanceId
    });

    await salvarDados('auth-presence', semAtual);
}

async function removerPresencaSessaoAtual() {
    const sessionId = String(currentSession?.id || '');
    const atuais = await lerDados('auth-presence');
    const ativos = filtrarPresencasAtivas(atuais);
    const filtrados = sessionId ? ativos.filter((item) => item.sessionId !== sessionId) : ativos;
    await salvarDados('auth-presence', filtrados);
}

function pararHeartbeatPresenca() {
    if (!authPresenceTimer) {
        return;
    }
    clearInterval(authPresenceTimer);
    authPresenceTimer = null;
}

function iniciarHeartbeatPresenca() {
    pararHeartbeatPresenca();
    authPresenceTimer = setInterval(() => {
        if (!currentSession) {
            return;
        }
        salvarPresencaSessaoAtual().catch((error) => {
            console.warn('Falha ao atualizar presenca da sessao:', error.message);
        });
    }, AUTH_PRESENCE_HEARTBEAT_MS);
}

async function encerrarSessaoAtual() {
    if (!currentSession) {
        pararHeartbeatPresenca();
        return;
    }
    try {
        await removerPresencaSessaoAtual();
    } catch (error) {
        console.warn('Falha ao remover presenca da sessao:', error.message);
    } finally {
        currentSession = null;
        pararHeartbeatPresenca();
    }
}

function normalizarTema(theme) {
    const valor = String(theme || '').trim().toLowerCase();
    if (valor === 'dark') return 'dark';
    if (valor === 'light') return 'light';
    if (valor === 'azul' || valor === 'blue' || valor === 'theme-azul') return 'blue';
    return 'blue';
}

function setupIpcHandlers() {
    ipcMain.handle('auth-login', async (event, credenciais) => {
        try {
            const username = String(credenciais?.username || '').trim().toLowerCase();
            const senha = String(credenciais?.password || '');

            if (!username || !senha) {
                throw new Error('Informe usuario e senha.');
            }

            const tentativas = obterStatusTentativas(username);
            if (tentativas.lockedUntil && tentativas.lockedUntil > Date.now()) {
                const restanteMin = Math.ceil((tentativas.lockedUntil - Date.now()) / 60000);
                throw new Error(`Usuario bloqueado temporariamente. Tente novamente em ${restanteMin} minuto(s).`);
            }

            const config = await garantirUsuariosAuth();
            const users = config.authUsers.map(sanitizeAuthUser);
            const user = users.find((item) => item.username === username && item.active);

            if (!user) {
                registrarFalhaLogin(username);
                throw new Error('Usuario ou senha invalidos.');
            }

            if (user.passwordHash !== hashSenha(senha)) {
                registrarFalhaLogin(username);
                throw new Error('Usuario ou senha invalidos.');
            }

            if (senhaExpirada(user)) {
                throw new Error('Senha expirada. Solicite ao administrador a redefinicao da senha.');
            }

            if (currentSession?.id) {
                await encerrarSessaoAtual();
            }
            currentSession = montarSessao(user);
            limparTentativasLogin(username);
            await salvarPresencaSessaoAtual();
            iniciarHeartbeatPresenca();
            return { ok: true, session: obterSessaoAtual() };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    ipcMain.handle('auth-logout', async () => {
        await encerrarSessaoAtual();
        return { ok: true };
    });

    ipcMain.handle('auth-get-session', async () => {
        await garantirUsuariosAuth();
        if (currentSession) {
            await salvarPresencaSessaoAtual();
        }
        return obterSessaoAtual();
    });

    ipcMain.handle('auth-list-users', async () => {
        try {
            exigirAdmin();
            const config = await garantirUsuariosAuth();
            const users = config.authUsers.map((item) => {
                const user = sanitizeAuthUser(item);
                return {
                    id: user.id,
                    username: user.username,
                    nome: user.nome,
                    role: user.role,
                    active: user.active
                };
            });
            return { ok: true, users };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    ipcMain.handle('auth-list-active-users', async () => {
        try {
            exigirAdmin();
            const presencas = await lerDados('auth-presence');
            const ativos = filtrarPresencasAtivas(presencas)
                .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
            await salvarDados('auth-presence', ativos);
            return { ok: true, activeUsers: ativos };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    ipcMain.handle('auth-list-online-users', async () => {
        try {
            exigirPermissaoAcao('auth-list-online-users');
            const presencas = await lerDados('auth-presence');
            const ativos = filtrarPresencasAtivas(presencas)
                .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
            const portalOnline = clientPortal ? clientPortal.listOnlineClients() : [];
            const usernames = [...new Set([
                ...ativos.map((item) => String(item?.username || '').toLowerCase()).filter(Boolean),
                ...portalOnline.map((item) => String(item?.username || '').toLowerCase()).filter(Boolean)
            ])];
            return { ok: true, usernames };
        } catch (error) {
            return { ok: false, message: error.message, usernames: [] };
        }
    });

    ipcMain.handle('auth-save-users', async (event, usersInput) => {
        try {
            exigirAdmin();
            const lista = Array.isArray(usersInput) ? usersInput : [];
            const configAtual = await garantirUsuariosAuth();
            const usersAtuais = configAtual.authUsers.map(sanitizeAuthUser);

            const users = lista.map((item) => {
                const username = String(item?.username || '').trim().toLowerCase();
                const existente = usersAtuais.find((u) => u.username === username);
                const senha = String(item?.password || '');
                if (!existente || senha) {
                    validarSenhaForteOuFalhar(senha);
                }
                const passwordHash = senha
                    ? hashSenha(senha)
                    : String(item?.passwordHash || existente?.passwordHash || '');

                return sanitizeAuthUser({
                    id: item?.id || existente?.id || Date.now(),
                    username,
                    nome: item?.nome || existente?.nome || username,
                    role: item?.role || existente?.role || 'recepcao',
                    passwordHash,
                    active: item?.active !== false,
                    passwordUpdatedAt: senha ? new Date().toISOString() : (existente?.passwordUpdatedAt || new Date().toISOString())
                });
            });

            validarListaUsuarios(users);
            await salvarDados('config', {
                ...configAtual,
                authUsers: users
            });
            return { ok: true };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    ipcMain.handle('data-get-version', async (event, tipo) => {
        try {
            if (!currentSession) throw new Error('Sessao nao autenticada.');
            const tipoSeguro = String(tipo || '').trim();
            if (!tipoSeguro) throw new Error('Tipo invalido.');
            const version = await obterVersaoTipo(tipoSeguro);
            return { ok: true, version };
        } catch (error) {
            return { ok: false, message: error.message, version: 0 };
        }
    });

    ipcMain.handle('audit-list', async (event, limitInput) => {
        try {
            exigirAdmin();
            const limit = Math.max(1, Math.min(200, Number(limitInput) || 50));
            const logs = await lerDados('audit-log');
            const lista = Array.isArray(logs) ? logs : [];
            return { ok: true, logs: lista.slice(-limit).reverse() };
        } catch (error) {
            return { ok: false, message: error.message, logs: [] };
        }
    });

    ipcMain.handle('audit-list-user', async (event, filtro) => {
        try {
            exigirPermissaoAcao('audit-list-user');
            const username = String(filtro?.username || '').trim().toLowerCase();
            if (!username) {
                throw new Error('Informe o usuário para filtrar a auditoria.');
            }
            const limit = Math.max(1, Math.min(5000, Number(filtro?.limit) || 200));
            const logs = await lerDados('audit-log');
            const lista = Array.isArray(logs) ? logs : [];
            const filtrados = lista.filter((item) => String(item?.actor?.username || '').trim().toLowerCase() === username);
            return { ok: true, logs: filtrados.slice(-limit).reverse() };
        } catch (error) {
            return { ok: false, message: error.message, logs: [] };
        }
    });

    ipcMain.handle('audit-export-user', async (event, filtro) => {
        try {
            exigirPermissaoAcao('audit-export-user');
            const username = String(filtro?.username || '').trim().toLowerCase();
            if (!username) {
                throw new Error('Informe o usuário para exportar auditoria.');
            }

            const logs = await lerDados('audit-log');
            const lista = Array.isArray(logs) ? logs : [];
            const filtrados = lista.filter((item) => String(item?.actor?.username || '').trim().toLowerCase() === username);

            const options = {
                title: 'Exportar Auditoria por Usuário',
                defaultPath: app.getPath('documents') + `/auditoria_${username}_${new Date().toISOString().slice(0,10)}.json`,
                filters: [{ name: 'JSON', extensions: ['json'] }]
            };

            const { filePath } = await dialog.showSaveDialog(mainWindow, options);
            if (!filePath) {
                return { ok: false, message: 'Exportação cancelada pelo usuário.' };
            }

            const payload = {
                exportedAt: new Date().toISOString(),
                username,
                total: filtrados.length,
                logs: filtrados
            };
            fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
            return { ok: true, filePath, total: filtrados.length };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    ipcMain.handle('audit-query', async (event, filtro) => {
        try {
            exigirPermissaoAcao('audit-query');
            const logs = await lerDados('audit-log');
            const lista = Array.isArray(logs) ? logs : [];
            const resultado = aplicarFiltroAuditoria(lista, filtro);
            return {
                ok: true,
                logs: resultado.items,
                total: resultado.total,
                appliedFilters: resultado.filtro,
                pagination: {
                    page: resultado.page,
                    pageSize: resultado.pageSize,
                    totalPages: resultado.totalPages
                }
            };
        } catch (error) {
            return { ok: false, message: error.message, logs: [], total: 0 };
        }
    });

    ipcMain.handle('audit-export-csv', async (event, filtro) => {
        try {
            exigirPermissaoAcao('audit-export-csv');
            const logs = await lerDados('audit-log');
            const lista = Array.isArray(logs) ? logs : [];
            const filtroSeguro = normalizarFiltroAuditoria({
                ...(filtro && typeof filtro === 'object' ? filtro : {}),
                limit: 5000
            });
            const resultado = aplicarFiltroAuditoria(lista, filtroSeguro, { paginar: false });
            const csv = converterAuditoriaParaCsv(resultado.items);

            const tagUsuario = filtroSeguro.username ? `_${filtroSeguro.username}` : '';
            const options = {
                title: 'Exportar Auditoria CSV',
                defaultPath: app.getPath('documents') + `/auditoria${tagUsuario}_${new Date().toISOString().slice(0,10)}.csv`,
                filters: [{ name: 'CSV', extensions: ['csv'] }]
            };

            const { filePath } = await dialog.showSaveDialog(mainWindow, options);
            if (!filePath) {
                return { ok: false, message: 'Exportacao cancelada pelo usuario.' };
            }

            fs.writeFileSync(filePath, csv, 'utf8');
            return { ok: true, filePath, total: resultado.items.length };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    const normalizarChatLista = (raw) => {
        const lista = Array.isArray(raw) ? raw : [];
        return lista.map((item) => {
            const readBy = Array.isArray(item?.readBy) ? item.readBy.map((r) => String(r || '').toLowerCase()) : [];
            const receivedBy = Array.isArray(item?.receivedBy) ? item.receivedBy.map((r) => String(r || '').toLowerCase()) : [];
            const deletedFor = Array.isArray(item?.deletedFor) ? item.deletedFor.map((r) => String(r || '').toLowerCase()) : [];
            return {
                ...item,
                readBy: [...new Set(readBy)],
                receivedBy: [...new Set(receivedBy)],
                deletedFor: [...new Set(deletedFor)]
            };
        });
    };

    const chatVisivelPara = (item, username) => {
        const user = String(username || '').toLowerCase();
        const fromUsername = String(item?.from?.username || '').trim().toLowerCase();
        const toUsername = String(item?.to?.username || '').trim().toLowerCase();
        const deletedFor = Array.isArray(item?.deletedFor) ? item.deletedFor.map((r) => String(r || '').toLowerCase()) : [];
        if (deletedFor.includes(user)) return false;
        if (!toUsername) return true;
        return toUsername === user || fromUsername === user;
    };

    const chatMesmaConversaPrivada = (item, a, b) => {
        const ua = String(a || '').toLowerCase();
        const ub = String(b || '').toLowerCase();
        const fromUsername = String(item?.from?.username || '').trim().toLowerCase();
        const toUsername = String(item?.to?.username || '').trim().toLowerCase();
        if (!toUsername) return false;
        return (fromUsername === ua && toUsername === ub) || (fromUsername === ub && toUsername === ua);
    };

    ipcMain.handle('chat-list', async (event, options) => {
        try {
            exigirPermissaoAcao('chat-list');
            const limit = Math.max(1, Math.min(500, Number(options?.limit) || 200));
            const username = String(currentSession?.username || '').trim().toLowerCase();
            const raw = await lerDados('chat-messages');
            const lista = normalizarChatLista(raw);
            let mudouRecebimento = false;
            const listaAtualizada = lista.map((item) => {
                if (!chatVisivelPara(item, username)) return item;
                const fromUsername = String(item?.from?.username || '').trim().toLowerCase();
                if (fromUsername === username) return item;
                const receivedBy = Array.isArray(item?.receivedBy) ? item.receivedBy.map((r) => String(r || '').toLowerCase()) : [];
                if (receivedBy.includes(username)) return item;
                mudouRecebimento = true;
                return {
                    ...item,
                    receivedBy: [...receivedBy, username]
                };
            });
            if (mudouRecebimento) {
                await salvarDados('chat-messages', listaAtualizada);
            }

            const visiveis = listaAtualizada.filter((item) => chatVisivelPara(item, username));
            const mensagens = visiveis
                .sort((a, b) => Date.parse(String(a?.at || '')) - Date.parse(String(b?.at || '')))
                .slice(-limit);

            const unread = mensagens.filter((item) => {
                const fromUsername = String(item?.from?.username || '').trim().toLowerCase();
                const readBy = Array.isArray(item?.readBy) ? item.readBy.map((r) => String(r || '').toLowerCase()) : [];
                return fromUsername !== username && !readBy.includes(username);
            }).length;

            return { ok: true, messages: mensagens, unread };
        } catch (error) {
            return { ok: false, message: error.message, messages: [], unread: 0 };
        }
    });

    ipcMain.handle('chat-send', async (event, payload) => {
        try {
            exigirPermissaoAcao('chat-send');
            const text = String(payload?.text || '').trim();
            const toUsername = String(payload?.toUsername || '').trim().toLowerCase();
            const attachment = validarAttachmentChat(payload?.attachment);
            if (!text && !attachment) {
                throw new Error('Mensagem vazia.');
            }
            if (text.length > 1000) {
                throw new Error('Mensagem muito longa (max. 1000 caracteres).');
            }

            const username = String(currentSession?.username || '').trim().toLowerCase();
            const nome = String(currentSession?.nome || username || 'Usuário');
            const role = String(currentSession?.role || '').trim().toLowerCase();
            let to = null;
            if (toUsername) {
                const [config, portalUsers] = await Promise.all([
                    garantirUsuariosAuth(),
                    clientPortal ? clientPortal.listClientUsers() : Promise.resolve([])
                ]);
                const target = [
                    ...config.authUsers
                    .map(sanitizeAuthUser)
                    .filter((u) => u.active)
                    .map((u) => ({ username: u.username, nome: u.nome || u.username, role: u.role })),
                    ...portalUsers
                ].find((u) => String(u?.username || '').toLowerCase() === toUsername);
                if (!target) {
                    throw new Error('Destinatário inválido ou inativo.');
                }
                if (String(target.username || '').toLowerCase() === username) {
                    throw new Error('Não é possível enviar mensagem privada para si mesmo.');
                }
                to = { username: target.username, nome: target.nome || target.username };
            }
            const raw = await lerDados('chat-messages');
            const lista = Array.isArray(raw) ? raw : [];

            const message = {
                id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
                at: new Date().toISOString(),
                from: { username, nome, role },
                to,
                text,
                attachment: attachment ? {
                    name: attachment.name,
                    path: attachment.path,
                    type: attachment.type,
                    size: attachment.size,
                    extension: attachment.extension,
                    kind: attachment.kind
                } : null,
                readBy: [username],
                receivedBy: [username],
                deletedFor: []
            };

            lista.push(message);
            const limite = 5000;
            const final = lista.length > limite ? lista.slice(lista.length - limite) : lista;
            await salvarDados('chat-messages', final);
            await registrarAuditoria({
                acao: 'chat-send',
                tipo: 'chat',
                antes: [],
                depois: [],
                detalhe: `Mensagem enviada por @${username}`
            });
            return { ok: true, message };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    ipcMain.handle('chat-users', async () => {
        try {
            exigirPermissaoAcao('chat-users');
            const [config, portalUsers] = await Promise.all([
                garantirUsuariosAuth(),
                clientPortal ? clientPortal.listClientUsers() : Promise.resolve([])
            ]);
            const users = [
                ...config.authUsers
                .map(sanitizeAuthUser)
                .filter((u) => u.active)
                .map((u) => ({
                    username: u.username,
                    nome: u.nome || u.username,
                    role: u.role
                })),
                ...portalUsers
            ]
                .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
            return { ok: true, users };
        } catch (error) {
            return { ok: false, message: error.message, users: [] };
        }
    });

    ipcMain.handle('chat-mark-read', async (event, input) => {
        try {
            exigirPermissaoAcao('chat-mark-read');
            const username = String(currentSession?.username || '').trim().toLowerCase();
            const ids = Array.isArray(input?.ids) ? input.ids.map((id) => String(id || '')) : [];
            const marcarTodos = Boolean(input?.all) || ids.length === 0;
            const alvoIds = new Set(ids);

            const raw = await lerDados('chat-messages');
            const lista = normalizarChatLista(raw);
            let mudou = false;

            const atualizado = lista.map((item) => {
                const id = String(item?.id || '');
                const fromUsername = String(item?.from?.username || '').trim().toLowerCase();
                const readBy = Array.isArray(item?.readBy)
                    ? item.readBy.map((r) => String(r || '').toLowerCase())
                    : [];
                const deveMarcar = chatVisivelPara(item, username) && fromUsername !== username && (marcarTodos || alvoIds.has(id));
                if (!deveMarcar || readBy.includes(username)) {
                    return item;
                }
                mudou = true;
                return {
                    ...item,
                    readBy: [...readBy, username]
                };
            });

            if (mudou) {
                await salvarDados('chat-messages', atualizado);
            }
            return { ok: true };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    ipcMain.handle('chat-delete-message', async (event, input) => {
        try {
            exigirPermissaoAcao('chat-delete-message');
            const username = String(currentSession?.username || '').trim().toLowerCase();
            const id = String(input?.id || '').trim();
            const mode = String(input?.mode || 'both').trim().toLowerCase();
            if (!id) throw new Error('Mensagem inválida.');

            const raw = await lerDados('chat-messages');
            const lista = normalizarChatLista(raw);
            const idx = lista.findIndex((item) => String(item?.id || '') === id);
            if (idx < 0) throw new Error('Mensagem não encontrada.');
            const msg = lista[idx];
            const fromUsername = String(msg?.from?.username || '').toLowerCase();
            if (fromUsername !== username) {
                throw new Error('Apenas o remetente pode excluir esta mensagem.');
            }

            if (mode === 'self') {
                const deletedFor = Array.isArray(msg?.deletedFor) ? msg.deletedFor.map((r) => String(r || '').toLowerCase()) : [];
                if (!deletedFor.includes(username)) {
                    msg.deletedFor = [...deletedFor, username];
                }
                lista[idx] = msg;
                await salvarDados('chat-messages', lista);
                return { ok: true };
            }

            const filtrada = lista.filter((item) => String(item?.id || '') !== id);
            await salvarDados('chat-messages', filtrada);
            return { ok: true };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    ipcMain.handle('chat-clear-conversation-self', async (event, input) => {
        try {
            exigirPermissaoAcao('chat-clear-conversation-self');
            const username = String(currentSession?.username || '').trim().toLowerCase();
            const targetUsername = String(input?.targetUsername || '').trim().toLowerCase();
            const raw = await lerDados('chat-messages');
            const lista = normalizarChatLista(raw);

            const atualizado = lista.map((item) => {
                const fromUsername = String(item?.from?.username || '').trim().toLowerCase();
                const toUsername = String(item?.to?.username || '').trim().toLowerCase();
                const deletedFor = Array.isArray(item?.deletedFor) ? item.deletedFor.map((r) => String(r || '').toLowerCase()) : [];
                let pertence = false;
                if (!targetUsername) {
                    pertence = !toUsername;
                } else {
                    pertence = chatMesmaConversaPrivada(item, username, targetUsername);
                }
                if (!pertence || deletedFor.includes(username)) {
                    return item;
                }
                return {
                    ...item,
                    deletedFor: [...deletedFor, username]
                };
            });

            await salvarDados('chat-messages', atualizado);
            return { ok: true };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    ipcMain.handle('chat-delete-conversation-both', async (event, input) => {
        try {
            exigirPermissaoAcao('chat-delete-conversation-both');
            const username = String(currentSession?.username || '').trim().toLowerCase();
            const targetUsername = String(input?.targetUsername || '').trim().toLowerCase();
            if (!targetUsername) {
                throw new Error('Selecione um usuário para excluir conversa para ambos.');
            }
            const raw = await lerDados('chat-messages');
            const lista = normalizarChatLista(raw);
            const filtrada = lista.filter((item) => !chatMesmaConversaPrivada(item, username, targetUsername));
            await salvarDados('chat-messages', filtrada);
            return { ok: true };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    ipcMain.handle('chat-pick-file', async () => {
        try {
            exigirPermissaoAcao('chat-pick-file');
            const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
                title: 'Selecionar arquivo para enviar',
                properties: ['openFile'],
                filters: [
                    { name: 'Arquivos permitidos', extensions: ['png', 'jpg', 'jpeg', 'pdf'] }
                ]
            });
            if (canceled || !Array.isArray(filePaths) || filePaths.length === 0) {
                return { ok: false, message: 'Seleção cancelada.' };
            }
            const srcPath = String(filePaths[0] || '');
            if (!srcPath || !fs.existsSync(srcPath)) {
                throw new Error('Arquivo inválido.');
            }
            const ext = path.extname(srcPath).toLowerCase();
            const nomeOriginal = path.basename(srcPath);
            const dir = getChatUploadsDir();
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const nomeDestino = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
            const dstPath = path.join(dir, nomeDestino);
            fs.copyFileSync(srcPath, dstPath);
            const attachment = validarAttachmentChat({
                name: nomeOriginal,
                path: dstPath
            });

            return {
                ok: true,
                attachment
            };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    ipcMain.handle('chat-open-file', async (event, input) => {
        try {
            exigirPermissaoAcao('chat-open-file');
            const filePath = String(input?.path || '').trim();
            if (!filePath || !fs.existsSync(filePath)) {
                throw new Error('Arquivo não encontrado.');
            }
            const result = await shell.openPath(filePath);
            if (result) {
                throw new Error(result);
            }
            return { ok: true };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    ipcMain.handle('dashboard-summary', async () => {
        try {
            exigirPermissaoAcao('dashboard-summary');
            const [registros, agendamentos, ocorrencias, presencas] = await Promise.all([
                lerDados('registros'),
                lerDados('agendamentos'),
                lerDados('ocorrencias'),
                lerDados('auth-presence')
            ]);
            const hoje = new Date().toISOString().slice(0, 10);
            const registrosHoje = (Array.isArray(registros) ? registros : [])
                .filter((r) => String(r?.dataHoraExame || '').slice(0, 10) === hoje).length;
            const agendamentosHoje = (Array.isArray(agendamentos) ? agendamentos : [])
                .filter((a) => String(a?.dataHora || '').slice(0, 10) === hoje).length;

            const ocorrenciasArray = Array.isArray(ocorrencias) ? ocorrencias : [];
            const ocorrenciasPendentes = ocorrenciasArray.filter((o) => normalizarTextoBusca(o?.status || '') !== 'concluido');
            const pendencias = ocorrenciasPendentes.length;
            const prioridadeDiasPadrao = (prioridadeRaw) => {
                const prioridade = normalizarTextoBusca(prioridadeRaw || 'media');
                if (prioridade === 'alta') return 1;
                if (prioridade === 'baixa') return 5;
                return 3;
            };
            const prazoEfetivoOcorrencia = (o) => {
                const prazo = String(o?.prazo || '').slice(0, 10);
                if (prazo && Number.isFinite(Date.parse(`${prazo}T00:00:00`))) {
                    return prazo;
                }
                const data = String(o?.data || '').slice(0, 10);
                if (!data || !Number.isFinite(Date.parse(`${data}T00:00:00`))) {
                    return '';
                }
                const base = new Date(`${data}T00:00:00`);
                base.setDate(base.getDate() + prioridadeDiasPadrao(o?.prioridade));
                return base.toISOString().slice(0, 10);
            };
            const hojeLocal = new Date();
            const hojeIso = new Date(hojeLocal.getFullYear(), hojeLocal.getMonth(), hojeLocal.getDate()).toISOString().slice(0, 10);

            const ativos = filtrarPresencasAtivas(presencas);
            const inconsistencias = [];
            const alertasDetalhados = [];
            try {
                validarDuplicidadeRegistros(Array.isArray(registros) ? registros : []);
            } catch (error) {
                inconsistencias.push(error.message);
                alertasDetalhados.push({ tipo: 'sistema', mensagem: error.message });
            }

            const pendentesAntigas = ocorrenciasPendentes.filter((o) => {
                const data = Date.parse(String(o?.data || ''));
                if (!Number.isFinite(data)) return false;
                return (Date.now() - data) > (7 * 24 * 60 * 60 * 1000);
            });
            if (pendentesAntigas.length > 0) {
                const mensagem = `${pendentesAntigas.length} ocorrência(s) pendente(s) há mais de 7 dias.`;
                inconsistencias.push(mensagem);
                alertasDetalhados.push({ tipo: 'sistema', mensagem });
            }

            const backups = listarBackupsAutomaticos();
            if (backups.length === 0) {
                const mensagem = 'Sem backup automático disponível.';
                inconsistencias.push(mensagem);
                alertasDetalhados.push({ tipo: 'sistema', mensagem });
            }

            if (ocorrenciasPendentes.length > 0) {
                const detalhadas = [...ocorrenciasPendentes]
                    .map((o) => {
                        const dataIso = String(o?.data || '').trim();
                        const data = Date.parse(dataIso);
                        const dataBr = Number.isFinite(data)
                            ? new Date(data).toLocaleDateString('pt-BR')
                            : 'data não informada';
                        const status = String(o?.status || 'Pendente').trim() || 'Pendente';
                        const responsavel = String(o?.responsavel || '').trim() || 'sem responsável';
                        const prazoEfetivo = prazoEfetivoOcorrencia(o);
                        const sla = prazoEfetivo
                            ? (prazoEfetivo < hojeIso ? 'Atrasada' : (prazoEfetivo === hojeIso ? 'Vence hoje' : 'No prazo'))
                            : 'Sem prazo';
                        const prazoBr = prazoEfetivo
                            ? new Date(`${prazoEfetivo}T00:00:00`).toLocaleDateString('pt-BR')
                            : 'sem prazo';
                        const descricao = String(o?.descricao || '').trim().replace(/\s+/g, ' ');
                        const trecho = descricao.length > 80 ? `${descricao.slice(0, 80)}...` : descricao;
                        return {
                            id: String(o?.id ?? ''),
                            sortKey: Number.isFinite(data) ? data : Number.MAX_SAFE_INTEGER,
                            responsavel,
                            sla,
                            text: `Pendência: ${dataBr} | ${status} | Resp: ${responsavel} | SLA: ${sla} (${prazoBr}) | ${trecho || 'sem descrição'}`
                        };
                    })
                    .sort((a, b) => a.sortKey - b.sortKey);

                const porResponsavel = new Map();
                let atrasadas = 0;
                let vencendoHoje = 0;
                detalhadas.forEach((item) => {
                    porResponsavel.set(item.responsavel, Number(porResponsavel.get(item.responsavel) || 0) + 1);
                    if (item.sla === 'Atrasada') atrasadas += 1;
                    if (item.sla === 'Vence hoje') vencendoHoje += 1;
                });

                const topResponsaveis = [...porResponsavel.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 3);
                topResponsaveis.forEach(([responsavel, total]) => {
                    const mensagem = `Pendências por responsável: ${responsavel} (${total}).`;
                    inconsistencias.push(mensagem);
                    alertasDetalhados.push({ tipo: 'sistema', mensagem });
                });
                if (atrasadas > 0) {
                    const mensagem = `${atrasadas} pendência(s) com SLA atrasado.`;
                    inconsistencias.push(mensagem);
                    alertasDetalhados.push({ tipo: 'sistema', mensagem });
                }
                if (vencendoHoje > 0) {
                    const mensagem = `${vencendoHoje} pendência(s) vencendo hoje.`;
                    inconsistencias.push(mensagem);
                    alertasDetalhados.push({ tipo: 'sistema', mensagem });
                }

                detalhadas.slice(0, 10).forEach((item) => {
                    inconsistencias.push(item.text);
                    alertasDetalhados.push({
                        tipo: 'pendencia-ocorrencia',
                        mensagem: item.text,
                        ocorrenciaId: item.id
                    });
                });
                if (detalhadas.length > 10) {
                    const mensagem = `... e mais ${detalhadas.length - 10} pendência(s).`;
                    inconsistencias.push(mensagem);
                    alertasDetalhados.push({ tipo: 'sistema', mensagem });
                }
            }

            return {
                ok: true,
                summary: {
                    registrosHoje,
                    agendamentosHoje,
                    pendenciasOcorrencias: pendencias,
                    usuariosAtivos: ativos.length,
                    alertas: inconsistencias,
                    alertasDetalhados
                }
            };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    ipcMain.handle('backup-list-auto', async () => {
        try {
            exigirPermissaoAcao('backup-list-auto');
            return { ok: true, backups: listarBackupsAutomaticos() };
        } catch (error) {
            return { ok: false, message: error.message, backups: [] };
        }
    });

    ipcMain.handle('backup-preview-auto', async (event, nomeArquivo) => {
        try {
            exigirPermissaoAcao('backup-preview-auto');
            const preview = obterPreviewBackupAutomatico(String(nomeArquivo || ''));
            return { ok: true, preview };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    ipcMain.handle('backup-restore-auto', async (event, nomeArquivo) => {
        try {
            exigirPermissaoAcao('backup-restore-auto');
            await restaurarBackupAutomatico(String(nomeArquivo || ''));
            return { ok: true };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });

    ipcMain.handle('patient-timeline', async (event, filtro) => {
        try {
            exigirPermissaoAcao('patient-timeline');
            const documento = String(filtro?.documento || '').trim();
            const nome = String(filtro?.nome || '').trim();
            if (!documento && !nome) {
                throw new Error('Informe documento ou nome para consultar o histÃ³rico.');
            }
            const result = await montarTimelinePaciente({ documento, nome });
            return { ok: true, ...result };
        } catch (error) {
            return { ok: false, message: error.message, timeline: [] };
        }
    });

    ipcMain.handle('ler-registros', async () => {
        try {
            exigirPermissaoAcao('ler-registros');
            return await lerDados('registros');
        } catch (error) {
            console.error('Erro ao ler registros:', error);
            dialog.showErrorBox('Erro', 'Nao foi possivel ler os registros: ' + error.message);
            return [];
        }
    });
    ipcMain.handle('salvar-registros', async (event, registrosInput) => {
        try {
            exigirPermissaoAcao('salvar-registros');
            const payload = normalizarPayloadSalvar(registrosInput);
            const registros = payload.data;
            await validarConcorrenciaOuFalhar('registros', payload.expectedVersion);
            const antes = await lerDados('registros');
            validarDuplicidadeRegistros(registros);
            await validarDuplicidadeGlobalPacientes(null, registros);
            await salvarDados('registros', registros);
            await incrementarVersaoTipo('registros');
            await registrarAuditoria({ acao: 'salvar', tipo: 'registros', antes, depois: registros, detalhe: payload.detalhe });
            return true;
        } catch (error) {
            console.error('Erro ao salvar registros:', error);
            dialog.showErrorBox('Erro', 'Nao foi possivel salvar os registros: ' + error.message);
            return false;
        }
    });
    ipcMain.handle('ler-pacientes', async () => {
        try {
            exigirPermissaoAcao('ler-pacientes');
            return await lerDados('pacientes');
        } catch (error) {
            console.error('Erro ao ler pacientes:', error);
            dialog.showErrorBox('Erro', 'Nao foi possivel ler os pacientes: ' + error.message);
            return [];
        }
    });
    ipcMain.handle('salvar-pacientes', async (event, pacientesInput) => {
        try {
            exigirPermissaoAcao('salvar-pacientes');
            const payload = normalizarPayloadSalvar(pacientesInput);
            const pacientes = payload.data;
            await validarConcorrenciaOuFalhar('pacientes', payload.expectedVersion);
            const antes = await lerDados('pacientes');
            await validarDuplicidadeGlobalPacientes(pacientes);
            await salvarDados('pacientes', pacientes);
            await incrementarVersaoTipo('pacientes');
            await registrarAuditoria({ acao: 'salvar', tipo: 'pacientes', antes, depois: pacientes, detalhe: payload.detalhe });
            return true;
        } catch (error) {
            console.error('Erro ao salvar pacientes:', error);
            dialog.showErrorBox('Erro', 'Nao foi possivel salvar os pacientes: ' + error.message);
            return false;
        }
    });
    ipcMain.handle('ler-agendamentos', async () => {
        try {
            exigirPermissaoAcao('ler-agendamentos');
            return await lerDados('agendamentos');
        } catch (error) {
            console.error('Erro ao ler agendamentos:', error);
            dialog.showErrorBox('Erro', 'Nao foi possivel ler os agendamentos: ' + error.message);
            return [];
        }
    });
    ipcMain.handle('salvar-agendamentos', async (event, agendamentosInput) => {
        try {
            exigirPermissaoAcao('salvar-agendamentos');
            const payload = normalizarPayloadSalvar(agendamentosInput);
            const agendamentos = payload.data;
            await validarConcorrenciaOuFalhar('agendamentos', payload.expectedVersion);
            const antes = await lerDados('agendamentos');
            await salvarDados('agendamentos', agendamentos);
            await incrementarVersaoTipo('agendamentos');
            await registrarAuditoria({ acao: 'salvar', tipo: 'agendamentos', antes, depois: agendamentos, detalhe: payload.detalhe });
            return true;
        } catch (error) {
            console.error('Erro ao salvar agendamentos:', error);
            dialog.showErrorBox('Erro', 'Nao foi possivel salvar os agendamentos: ' + error.message);
            return false;
        }
    });
    ipcMain.handle('ler-medicos-agenda', async () => {
        try {
            exigirPermissaoAcao('ler-medicos-agenda');
            return await lerDados('medicos-agenda');
        } catch (error) {
            console.error('Erro ao ler agendas medicas:', error);
            dialog.showErrorBox('Erro', 'Nao foi possivel ler as agendas medicas: ' + error.message);
            return [];
        }
    });
    ipcMain.handle('salvar-medicos-agenda', async (event, medicosAgendaInput) => {
        try {
            exigirPermissaoAcao('salvar-medicos-agenda');
            const payload = normalizarPayloadSalvar(medicosAgendaInput);
            const medicosAgenda = payload.data;
            await validarConcorrenciaOuFalhar('medicos-agenda', payload.expectedVersion);
            const antes = await lerDados('medicos-agenda');
            await salvarDados('medicos-agenda', medicosAgenda);
            await incrementarVersaoTipo('medicos-agenda');
            await registrarAuditoria({ acao: 'salvar', tipo: 'medicos-agenda', antes, depois: medicosAgenda, detalhe: payload.detalhe });
            return true;
        } catch (error) {
            console.error('Erro ao salvar agendas medicas:', error);
            dialog.showErrorBox('Erro', 'Nao foi possivel salvar as agendas medicas: ' + error.message);
            return false;
        }
    });
    ipcMain.handle('buscar-global', async (event, termo) => {
        try {
            exigirPermissaoAcao('buscar-global');
            const consulta = normalizarTextoBusca(termo);
            if (!consulta) {
                return [];
            }

            const [pacientes, agendamentos, registros] = await Promise.all([
                lerDados('pacientes'),
                lerDados('agendamentos'),
                lerDados('registros')
            ]);

            const resultados = [];

            const pacientesArray = Array.isArray(pacientes) ? pacientes : [];
            for (const item of pacientesArray) {
                if (montarDocumentoBusca(item).includes(consulta)) {
                    resultados.push(criarResultadoBusca('Pacientes', item, 'agendamento/agendamento.html'));
                }
            }

            const agendamentosArray = Array.isArray(agendamentos) ? agendamentos : [];
            for (const item of agendamentosArray) {
                if (montarDocumentoBusca(item).includes(consulta)) {
                    resultados.push(criarResultadoBusca('Agendamentos', item, 'agendamento/agendamento.html'));
                }
            }

            const registrosArray = Array.isArray(registros) ? registros : [];
            for (const item of registrosArray) {
                if (montarDocumentoBusca(item).includes(consulta)) {
                    resultados.push(criarResultadoBusca('Registros', item, 'registros/registros.html'));
                }
            }

            return deduplicarResultadosBusca(resultados).slice(0, 100);
        } catch (error) {
            console.error('Erro na busca global:', error);
            dialog.showErrorBox('Erro', 'Nao foi possivel realizar a busca global: ' + error.message);
            return [];
        }
    });
    ipcMain.handle('salvar-arquivo', async (event, {conteudo, tipo}) => {
        exigirPermissaoAcao('salvar-arquivo');
        const options = {
            defaultPath: app.getPath('documents') + `/registros_${new Date().toISOString().slice(0,10)}.${tipo}`,
            filters: [
                { name: tipo.toUpperCase(), extensions: [tipo] }
            ]
        }
      
        const { filePath } = await dialog.showSaveDialog(options)
        if (filePath) {
          fs.writeFileSync(filePath, conteudo)
          return true
        }
        return false
    });

    ipcMain.handle('exportar-pdf', async (event, registros) => {
        try {
            exigirPermissaoAcao('exportar-pdf');
            const options = {
                title: 'Salvar PDF',
                defaultPath: app.getPath('documents') + `/registros_${new Date().toISOString().slice(0,10)}.pdf`,
                filters: [{ name: 'PDF', extensions: ['pdf'] }]
            };

            const { filePath } = await dialog.showSaveDialog(options);
            if (!filePath) return false;

            const doc = new PDFDocument({
                margins: { top: 30, bottom: 30, left: 20, right: 20 },
                size: 'A4'
            });
            const stream = fs.createWriteStream(filePath);

            doc.pipe(stream);

            // CabeÃƒÆ’Ã‚Â§alho
            doc.fontSize(24)
               .font('Helvetica-Bold')
               .text('Registro de Pacientes', {align: 'center'});
            doc.moveDown();

            // Data do relatÃƒÆ’Ã‚Â³rio
            doc.fontSize(8)
               .font('Helvetica')
               .text(`RelatÃƒÆ’Ã‚Â³rio gerado em: ${new Date().toLocaleString('pt-BR')}`, {align: 'right'});
            doc.moveDown(2);

            // Define larguras das colunas
            const colWidths = {
                nome: 160,
                modalidade: 80,
                exame: 80,
                acesso: 70,
                dataHora: 100,
                tecnico: 70
            };

            // CabeÃƒÆ’Ã‚Â§alho da tabela com fundo azul claro
            doc.font('Helvetica-Bold')
               .fontSize(10);

            const tableWidth = 560; // Largura total da tabela
            const tableX = 20; // PosiÃƒÆ’Ã‚Â§ÃƒÆ’Ã‚Â£o X inicial da tabela
            const headerY = doc.y;

            // CabeÃƒÆ’Ã‚Â§alho com fundo azul claro
            doc.fillColor('#e8eef7')
               .rect(tableX, headerY, tableWidth, 20)
               .fill()
               .fillColor('#000');

            // Textos do cabeÃƒÆ’Ã‚Â§alho
            let currentX = tableX;
            doc.text('Nome', currentX, headerY + 5, {width: colWidths.nome});
            currentX += colWidths.nome;
            doc.text('Modalidade', currentX, headerY + 5, {width: colWidths.modalidade});
            currentX += colWidths.modalidade;
            doc.text('Exame', currentX, headerY + 5, {width: colWidths.exame});
            currentX += colWidths.exame;
            doc.text('Acesso', currentX, headerY + 5, {width: colWidths.acesso});
            currentX += colWidths.acesso;
            doc.text('Data/Hora', currentX, headerY + 5, {width: colWidths.dataHora});
            currentX += colWidths.dataHora;
            doc.text('TÃƒÆ’Ã‚Â©cnico', currentX, headerY + 5, {width: colWidths.tecnico});

            doc.moveDown();

            // Registros com cores alternadas
            doc.font('Helvetica')
               .fontSize(7);

            registros.forEach((r, index) => {
                const rowY = doc.y;
                
                // Alternar cores das linhas (branco e azul mais claro)
                if (index % 2 === 1) {
                    doc.fillColor('#f5f8fd')
                       .rect(tableX, rowY, tableWidth, 20)
                       .fill()
                       .fillColor('#000');
                }
                
                // Dados do registro
                currentX = tableX;
                doc.text(r.nomePaciente || '', currentX, rowY + 5, {width: colWidths.nome});
                currentX += colWidths.nome;
                doc.text(r.modalidade || '', currentX, rowY + 5, {width: colWidths.modalidade});
                currentX += colWidths.modalidade;
                doc.text(r.observacoes || '', currentX, rowY + 5, {width: colWidths.exame});
                currentX += colWidths.exame;
                doc.text(r.numeroAcesso || '', currentX, rowY + 5, {width: colWidths.acesso});
                currentX += colWidths.acesso;
                doc.text(new Date(r.dataHoraExame).toLocaleString('pt-BR'), currentX, rowY + 5, {width: colWidths.dataHora});
                currentX += colWidths.dataHora;
                doc.text(r.nomeTecnico || '', currentX, rowY + 5, {width: colWidths.tecnico});

                // ObservaÃƒÆ’Ã‚Â§ÃƒÆ’Ã‚Âµes adicionais
                if (r.observacoesAdicionais) {
                    doc.moveDown(0.7);
                    doc.fillColor('#666666')
                       .text(`Obs: ${r.observacoesAdicionais}`, tableX + 20, doc.y, {
                           width: tableWidth - 40,
                           align: 'left'
                       })
                       .fillColor('#000');
                }

                doc.moveDown();

                // Adiciona nova pÃƒÆ’Ã‚Â¡gina se necessÃƒÆ’Ã‚Â¡rio
                if (doc.y > 750) {
                    doc.addPage();
                    doc.fontSize(8);
                }
            });

            // RodapÃƒÆ’Ã‚Â©
            doc.fontSize(8)
               .text(`Documento gerado automaticamente em ${new Date().toLocaleString('pt-BR')}`, 50, doc.page.height - 50, {
                   align: 'center'
               });

            // Finaliza o documento
            doc.end();

            return new Promise((resolve) => {
                stream.on('finish', () => {
                    dialog.showMessageBox({
                        type: 'info',
                        message: 'PDF gerado com sucesso!'
                    });
                    resolve(true);
                });

                stream.on('error', (error) => {
                    dialog.showErrorBox('Erro', 'Falha ao gerar PDF: ' + error.message);
                    resolve(false);
                });
            });

        } catch (error) {
            dialog.showErrorBox('Erro', 'Falha ao gerar PDF: ' + error.message);
            return false;
        }
    });

    ipcMain.handle('exportar-csv', async (event, registros) => {
        try {
            exigirPermissaoAcao('exportar-csv');
            const options = {
                title: 'Salvar Excel',
                defaultPath: app.getPath('documents') + `/registros_${new Date().toISOString().slice(0,10)}.xlsx`,
                filters: [{ name: 'Excel', extensions: ['xlsx'] }]
            };

            const { filePath } = await dialog.showSaveDialog(options);
            if (!filePath) return false;

            // Cria uma nova planilha
            const wb = XLSX.utils.book_new();

            // Define estilos
            const styles = {
                titulo: {
                    font: { bold: true, sz: 18, color: { rgb: '000000' } },
                    alignment: { horizontal: 'center', vertical: 'center' },
                    fill: { fgColor: { rgb: 'FFFFFF' } }
                },
                cabecalho: {
                    font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } },
                    fill: { fgColor: { rgb: '4F81BD' } },
                    alignment: { horizontal: 'center', vertical: 'center' },
                    border: {
                        top: { style: 'thin', color: { rgb: '000000' } },
                        bottom: { style: 'thin', color: { rgb: '000000' } },
                        left: { style: 'thin', color: { rgb: '000000' } },
                        right: { style: 'thin', color: { rgb: '000000' } }
                    }
                },
                celula: {
                    font: { sz: 11 },
                    alignment: { vertical: 'center', wrapText: true },
                    border: {
                        top: { style: 'thin', color: { rgb: '000000' } },
                        bottom: { style: 'thin', color: { rgb: '000000' } },
                        left: { style: 'thin', color: { rgb: '000000' } },
                        right: { style: 'thin', color: { rgb: '000000' } }
                    }
                },
                celulaAlternada: {
                    font: { sz: 11 },
                    fill: { fgColor: { rgb: 'F2F2F2' } },
                    alignment: { vertical: 'center', wrapText: true },
                    border: {
                        top: { style: 'thin', color: { rgb: '000000' } },
                        bottom: { style: 'thin', color: { rgb: '000000' } },
                        left: { style: 'thin', color: { rgb: '000000' } },
                        right: { style: 'thin', color: { rgb: '000000' } }
                    }
                }
            };

            // Prepara os dados com estilos
            const dados = registros.map((r, index) => ([
                { v: r.nomePaciente || '', s: index % 2 ? styles.celulaAlternada : styles.celula },
                { v: r.modalidade || '', s: index % 2 ? styles.celulaAlternada : styles.celula },
                { v: r.observacoes || '', s: index % 2 ? styles.celulaAlternada : styles.celula },
                { v: r.numeroAcesso || '', s: index % 2 ? styles.celulaAlternada : styles.celula },
                { v: new Date(r.dataHoraExame).toLocaleString('pt-BR'), s: index % 2 ? styles.celulaAlternada : styles.celula },
                { v: r.nomeTecnico || '', s: index % 2 ? styles.celulaAlternada : styles.celula },
                { v: r.observacoesAdicionais || '', s: index % 2 ? styles.celulaAlternada : styles.celula }
            ]));

            // Adiciona cabeÃƒÆ’Ã‚Â§alho
            dados.unshift([
                { v: 'Nome do Paciente', s: styles.cabecalho },
                { v: 'Modalidade', s: styles.cabecalho },
                { v: 'Exame', s: styles.cabecalho },
                { v: 'NÃƒÆ’Ã‚Âºmero de Acesso', s: styles.cabecalho },
                { v: 'Data/Hora', s: styles.cabecalho },
                { v: 'TÃƒÆ’Ã‚Â©cnico', s: styles.cabecalho },
                { v: 'ObservaÃƒÆ’Ã‚Â§ÃƒÆ’Ã‚Âµes', s: styles.cabecalho }
            ]);

            // Adiciona tÃƒÆ’Ã‚Â­tulo
            dados.unshift([{ v: 'Registro de Pacientes', s: styles.titulo }], 
                         [{ v: `RelatÃƒÆ’Ã‚Â³rio gerado em: ${new Date().toLocaleString('pt-BR')}`, s: styles.celula }],
                         []);

            // Cria a planilha
            const ws = XLSX.utils.aoa_to_sheet(dados);

            // Configura mesclagem de cÃƒÆ’Ã‚Â©lulas
            ws['!merges'] = [
                { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
                { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } }
            ];

            // Define larguras das colunas
            ws['!cols'] = [
                { wch: 60 }, // Nome do Paciente
                { wch: 15 }, // Modalidade
                { wch: 30 }, // Exame
                { wch: 20 }, // NÃƒÆ’Ã‚Âºmero de Acesso
                { wch: 20 }, // Data/Hora
                { wch: 20 }, // TÃƒÆ’Ã‚Â©cnico
                { wch: 80 }  // ObservaÃƒÆ’Ã‚Â§ÃƒÆ’Ã‚Âµes
            ];

            // Adiciona a planilha ao workbook
            XLSX.utils.book_append_sheet(wb, ws, 'Registros');

            // Salva o arquivo
            XLSX.writeFile(wb, filePath);
            
            dialog.showMessageBox({
                type: 'info',
                message: 'Excel exportado com sucesso!'
            });
            
            return true;
        } catch (error) {
            dialog.showErrorBox('Erro', 'Falha ao exportar Excel: ' + error.message);
            return false;
        }
    });

    ipcMain.handle('importar-arquivo', async (event) => {
        try {
          exigirPermissaoAcao('importar-arquivo');
          const result = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [
              { name: 'JSON', extensions: ['json'] }
            ]
          });
      
          if (!result.canceled && result.filePaths.length > 0) {
            const conteudo = await fs.promises.readFile(result.filePaths[0], 'utf8');
            // Envia os dados para o renderer
            event.sender.send('arquivo-importado', conteudo);
            return true;
          }
          return false;
        } catch (error) {
          console.error('Erro ao importar arquivo:', error);
          return false;
        }
      });

    // Adicionar handlers para ocorrÃƒÆ’Ã‚Âªncias
    ipcMain.handle('ler-ocorrencias', async () => {
        try {
            exigirPermissaoAcao('ler-ocorrencias');
            return await lerDados('ocorrencias');
        } catch (error) {
            console.error('Erro ao ler ocorrencias:', error);
            dialog.showErrorBox('Erro', 'Nao foi possivel ler as ocorrencias: ' + error.message);
            return [];
        }
    });
    ipcMain.handle('salvar-ocorrencias', async (event, ocorrenciasInput) => {
        try {
            exigirPermissaoAcao('salvar-ocorrencias');
            const payload = normalizarPayloadSalvar(ocorrenciasInput);
            const ocorrencias = payload.data;
            await validarConcorrenciaOuFalhar('ocorrencias', payload.expectedVersion);
            const antes = await lerDados('ocorrencias');
            await salvarDados('ocorrencias', ocorrencias);
            await incrementarVersaoTipo('ocorrencias');
            await registrarAuditoria({ acao: 'salvar', tipo: 'ocorrencias', antes, depois: ocorrencias, detalhe: payload.detalhe });
            return true;
        } catch (error) {
            console.error('Erro ao salvar ocorrencias:', error);
            dialog.showErrorBox('Erro', 'Nao foi possivel salvar as ocorrencias: ' + error.message);
            return false;
        }
    });
    // Adicionar handlers para ponto
    ipcMain.handle('ler-ponto', async () => {
        try {
            exigirPermissaoAcao('ler-ponto');
            return await lerDados('ponto');
        } catch (error) {
            console.error('Erro ao ler ponto:', error);
            dialog.showErrorBox('Erro', 'Nao foi possivel ler os dados de ponto: ' + error.message);
            return { funcionarios: [], registros: [] };
        }
    });
    ipcMain.handle('salvar-ponto', async (event, dadosInput) => {
        try {
            exigirPermissaoAcao('salvar-ponto');
            const payload = normalizarPayloadSalvar(dadosInput);
            const dados = payload.data;
            await validarConcorrenciaOuFalhar('ponto', payload.expectedVersion);
            const antes = await lerDados('ponto');
            await salvarDados('ponto', dados);
            await incrementarVersaoTipo('ponto');
            await registrarAuditoria({ acao: 'salvar', tipo: 'ponto', antes, depois: dados, detalhe: payload.detalhe });
            return true;
        } catch (error) {
            console.error('Erro ao salvar ponto:', error);
            dialog.showErrorBox('Erro', 'Nao foi possivel salvar os dados de ponto: ' + error.message);
            return false;
        }
    });
    // Handler para ler configuraÃƒÆ’Ã‚Â§ÃƒÆ’Ã‚Â£o
    ipcMain.handle('ler-config', async () => {
        try {
            return await lerDados('config');
        } catch (error) {
            console.error('Erro ao ler config:', error);
            return {};
        }
    });
    // Handler para salvar configuraÃƒÆ’Ã‚Â§ÃƒÆ’Ã‚Â£o
    ipcMain.handle('salvar-config', async (event, config) => {
        try {
            exigirPermissaoAcao('salvar-config');
            const antes = await lerDados('config');
            await salvarDados('config', config);
            await incrementarVersaoTipo('config');
            await registrarAuditoria({ acao: 'salvar', tipo: 'config', antes, depois: config, detalhe: 'Atualizacao de configuracao' });
            return true;
        } catch (error) {
            console.error('Erro ao salvar config:', error);
            dialog.showErrorBox('Erro', 'Nao foi possivel salvar a configuracao: ' + error.message);
            return false;
        }
    });

    ipcMain.handle('get-theme', async () => {
        try {
            exigirPermissaoAcao('get-theme');
            const config = await lerDados('config');
            return normalizarTema(config?.theme);
        } catch (error) {
            console.error('Erro ao obter tema:', error);
            return 'blue';
        }
    });

    ipcMain.handle('set-theme', async (event, theme) => {
        try {
            exigirPermissaoAcao('set-theme');
            const temaNormalizado = normalizarTema(theme);
            const configAtual = await lerDados('config');
            const novoConfig = (configAtual && typeof configAtual === 'object')
                ? { ...configAtual, theme: temaNormalizado }
                : { theme: temaNormalizado };
            await salvarDados('config', novoConfig);
            await incrementarVersaoTipo('config');
            await registrarAuditoria({ acao: 'tema', tipo: 'config', antes: configAtual, depois: novoConfig, detalhe: `Tema: ${temaNormalizado}` });
            return { ok: true, theme: temaNormalizado };
        } catch (error) {
            console.error('Erro ao salvar tema:', error);
            return { ok: false, message: error.message };
        }
    });
}


// FunÃƒÆ’Ã‚Â§ÃƒÆ’Ã‚Â£o auxiliar para formatar campos do CSV
function formatCsvField(value, maxWidth) {
    if (value === null || value === undefined) {
        value = '';
    }
    value = value.toString();
    
    // Remove quebras de linha e vÃƒÆ’Ã‚Â­rgulas
    value = value.replace(/[\r\n]+/g, ' ').replace(/,/g, ';');
    
    // Trunca o texto se exceder a largura mÃƒÆ’Ã‚Â¡xima
    if (value.length > maxWidth) {
        value = value.substring(0, maxWidth - 3) + '...';
    }
    
    // Escapa aspas duplas e envolve o campo em aspas
    value = value.replace(/"/g, '""');
    return `"${value}"`;
}

async function fazerBackup() {
    try {
        const registros = await lerDados('registros');
        const data = JSON.stringify(registros, null, 2);
        
        const hoje = new Date().toISOString().slice(0,10);
        const options = {
            title: 'Salvar Backup',
            defaultPath: app.getPath('documents') + `/backup_registros_${hoje}.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }]
        };

        const { filePath } = await dialog.showSaveDialog(mainWindow, options);
        if (filePath) {
            fs.writeFileSync(filePath, data, 'utf8');
            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Sucesso',
                message: 'Backup realizado com sucesso!'
            });
        }
    } catch (error) {
        dialog.showErrorBox('Erro', 'Falha ao fazer backup: ' + error.message);
    }
}

async function importarBackup() {
    try {
        const options = {
            title: 'Importar Backup',
            filters: [{ name: 'JSON', extensions: ['json'] }],
            properties: ['openFile']
        };

        const { filePaths } = await dialog.showOpenDialog(mainWindow, options);
        if (filePaths.length > 0) {
            // LÃƒÆ’Ã‚Âª o arquivo de backup
            const backupData = fs.readFileSync(filePaths[0], 'utf8');
            
            // Tenta fazer o parse para garantir que ÃƒÆ’Ã‚Â© um JSON vÃƒÆ’Ã‚Â¡lido
            const parsedData = JSON.parse(backupData);
            if (!Array.isArray(parsedData)) {
                throw new Error('Formato de backup invalido. Esperado: array de registros.');
            }

            // Confirma com o usuÃƒÆ’Ã‚Â¡rio
            const { response } = await dialog.showMessageBox(mainWindow, {
                type: 'warning',
                buttons: ['Sim', 'NÃƒÆ’Ã‚Â£o'],
                title: 'ConfirmaÃƒÆ’Ã‚Â§ÃƒÆ’Ã‚Â£o',
                message: 'Isso substituirÃƒÆ’Ã‚Â¡ todos os registros atuais. Deseja continuar?'
            });

            if (response === 0) { // Se clicou em 'Sim'
                await salvarDados('registros', parsedData);
                
                dialog.showMessageBox(mainWindow, {
                    type: 'info',
                    title: 'Sucesso',
                    message: 'Backup importado com sucesso! A aplicaÃƒÆ’Ã‚Â§ÃƒÆ’Ã‚Â£o serÃƒÆ’Ã‚Â¡ reiniciada.',
                    buttons: ['OK']
                }).then(() => {
                    app.relaunch();
                    app.exit();
                });
            }
        }
    } catch (error) {
        dialog.showErrorBox('Erro', 'Falha ao importar backup: ' + error.message);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 1000,
        show: false,
        title: 'Registro de Pacientes v2.0', // Adicionado tÃƒÆ’Ã‚Â­tulo com versÃƒÆ’Ã‚Â£o
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'src', 'pages', 'auth', 'login.html'));
    mainWindow.maximize();
    mainWindow.show();

    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });

    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        console.error(`Falha ao carregar renderer: ${errorDescription} (${errorCode}) em ${validatedURL}`);
    });

    mainWindow.webContents.on('render-process-gone', (event, details) => {
        console.error('Renderer finalizado inesperadamente:', details);
    });

    mainWindow.webContents.on('did-finish-load', async () => {
        try {
            const diagnostico = await mainWindow.webContents.executeJavaScript(`
                ({
                    href: window.location.href,
                    title: document.title,
                    readyState: document.readyState,
                    hasRequire: typeof require,
                    hasProcess: typeof process,
                    hasElectronRequire: (() => {
                        try {
                            const electron = require('electron');
                            return typeof electron;
                        } catch (error) {
                            return 'erro:' + error.message;
                        }
                    })(),
                    scriptCount: document.scripts.length,
                    bodyExists: !!document.body
                })
            `, true);
            console.log('[renderer:diagnostico]', JSON.stringify(diagnostico));
        } catch (error) {
            console.error('Falha ao diagnosticar renderer:', error.message);
        }
    });

    const menu = Menu.buildFromTemplate([
        {
            label: 'Arquivo',
            submenu: [
                {
                    label: 'Exportar',    
                    click: () => mainWindow.webContents.send('show-export-modal')                    
                },
                { type: 'separator' },
                {
                    label: 'Importar',
                    click: () => mainWindow.webContents.send('start-import')
                },                                
                { type: 'separator' },
                {
                    label: 'Sair',
                    click: () => app.quit()
                }
               
            ]
        },
        {
            label: 'Temas',
            submenu: [
                {
                    label: 'Claro',
                    click: () => mainWindow.webContents.send('change-theme', 'light')
                },
                {
                    label: 'Escuro',
                    click: () => mainWindow.webContents.send('change-theme', 'dark')
                },
                {
                    label: 'Azul',
                    click: () => mainWindow.webContents.send('change-theme', 'blue')
                }
            ]
        },
        {
            label: 'Ajuda',
            submenu: [
                {
                    label: 'Manual',
                    click: createHelpWindow
                }
            ]
        }
    ]);

    Menu.setApplicationMenu(menu);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }
}

function createHelpWindow() {
    if (helpWindow) {
        helpWindow.focus();
        return;
    }

    helpWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        title: 'Manual do Sistema',
        autoHideMenuBar: true,
        parent: mainWindow,
        modal: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    const manualPath = path.join(__dirname, 'MANUAL.md');
    try {
        const content = fs.readFileSync(manualPath, 'utf8');
        // Configurar o marked antes de usar
        marked.use({
            mangle: false,
            headerIds: false
        });
        
        const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <style>
                    body {
                        font-family: 'Segoe UI', Arial, sans-serif;
                        line-height: 1.6;
                        padding: 20px;
                        max-width: 800px;
                        margin: 0 auto;
                        background: #ffffff;
                        color: #333;
                    }
                    h1, h2, h3 { 
                        color: #2c3e50; 
                        margin-top: 1.5em;
                    }
                    code { 
                        background: #f8f9fa; 
                        padding: 2px 4px; 
                        border-radius: 3px; 
                    }
                    pre { 
                        background: #f8f9fa; 
                        padding: 15px; 
                        border-radius: 5px; 
                    }
                    ul, ol {
                        padding-left: 20px;
                    }
                    li {
                        margin: 5px 0;
                    }
                </style>
            </head>
            <body>
                ${marked.parse(content)}
            </body>
            </html>
        `;

        helpWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
        
        // Adiciona manipulador de erro
        helpWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
            console.error('Erro ao carregar conteÃƒÆ’Ã‚Âºdo:', errorDescription);
            dialog.showErrorBox('Erro', 'Falha ao carregar o manual: ' + errorDescription);
        });
    } catch (error) {
        console.error('Erro ao carregar o manual:', error);
        dialog.showErrorBox('Erro', 'NÃƒÆ’Ã‚Â£o foi possÃƒÆ’Ã‚Â­vel carregar o manual: ' + error.message);
    }

    helpWindow.on('closed', () => {
        helpWindow = null;
    });
}

app.whenReady().then(async () => {
    try {
        const onlineNoInicio = await inicializarPersistencia();
        iniciarLoopBackupAutomatico();
        criarBackupAutomatico().catch((error) => {
            console.warn('Falha no backup automatico inicial:', error.message);
        });
        setupIpcHandlers();
        clientPortal = createClientPortalServer({
            baseDir: __dirname,
            port: CLIENT_PORTAL_PORT,
            host: CLIENT_PORTAL_HOST,
            cpfSomenteDigitos,
            normalizarProntuario,
            hashSenha,
            validarSenhaForteOuFalhar,
            obterStatusTentativas,
            registrarFalhaLogin,
            limparTentativasLogin,
            lerDados,
            salvarDados,
            obterConfigAuth,
            garantirUsuariosAuth,
            sanitizeAuthUser,
            filtrarPresencasAtivas,
            getMongoOnline: () => mongoOnline
        });
        try {
            clientPortalServer = await clientPortal.start();
            console.log(`Portal do cliente disponível em http://${CLIENT_PORTAL_HOST}:${CLIENT_PORTAL_PORT}/cliente/`);
        } catch (error) {
            clientPortalServer = null;
            console.warn(`Portal do cliente indisponível: ${error.message}`);
        }
        createWindow();

        if (!onlineNoInicio) {
            dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: 'Modo Offline',
                message: 'Sem conexao com MongoDB. Os dados serao salvos localmente e sincronizados quando a conexao voltar.'
            });
        }

        // Copiar o manual para o diretÃƒÆ’Ã‚Â³rio de instalaÃƒÆ’Ã‚Â§ÃƒÆ’Ã‚Â£o
        const manualSourcePath = path.join(__dirname, 'MANUAL.md');
        const manualDestPath = path.join(__dirname, 'MANUAL.md');
        fs.copyFileSync(manualSourcePath, manualDestPath);
    } catch (error) {
        console.error('Falha ao iniciar a aplicacao:', error);
        dialog.showErrorBox('Erro de Inicializacao', 'Nao foi possivel iniciar a aplicacao: ' + error.message);
        app.quit();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on('second-instance', () => {
    if (!mainWindow) {
        createWindow();
        return;
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    mainWindow.focus();
});

app.on('before-quit', () => {
    encerrarSessaoAtual().catch((error) => {
        console.warn('Falha ao encerrar sessao na saida:', error.message);
    });

    if (clientPortalServer) {
        clientPortalServer.close();
        clientPortalServer = null;
    }

    if (autoBackupTimer) {
        clearInterval(autoBackupTimer);
        autoBackupTimer = null;
    }

    if (reconnectTimer) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
    }

    if (mongoClient) {
        mongoClient.close().catch((error) => {
            console.error('Erro ao fechar conexao com MongoDB:', error);
        });
    }
});
