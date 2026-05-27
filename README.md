# Registro de Pacientes - v2.0

<div align="center">

![Desktop Preview](src/assets/images/image.gif)

![Electron](https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)

[![rodrigodev.net](https://img.shields.io/badge/rodrigodev.net-green?style=for-the-badge)](https://www.rodrigodev.net/)
[![GitHub](https://img.shields.io/badge/GitHub-100000?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Rodrigogfernandes)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/rodrigogfernandes/)
[![Instagram](https://img.shields.io/badge/Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white)](https://www.instagram.com/rodrigogfernandes1/)

[![Protótipo Online](https://img.shields.io/badge/Prot%C3%B3tipo-Acessar%20Online-blue?style=for-the-badge&logo=render&logoColor=white)](https://prototype-kpqe.onrender.com)

</div>

> Protótipo online disponível em: [prototype-kpqe.onrender.com](https://prototype-kpqe.onrender.com)

## Sobre o Projeto

Aplicacao desktop em Electron para gestao de:
- agendamento de exames
- registros de pacientes/exames
- livro de ocorrencias
- controle de ponto

O sistema opera com MongoDB (Atlas ou local) e possui modo offline com backup JSON automatico.

## Membros do grupo 
- Felipe Maciel Soares - 1362419474
- João Pedro firmo lira da costa - 1362316447
- Roberto Carlos da Silva Figueiredo - 1362318889
-Rodrigo Guedes Fernandes Ra 1362423958
- Teófilo da costa Fernandes Ra-  1362321634
-


## Funcionalidades

- Cadastro e edicao de pacientes com CPF e prontuario.
- Geracao automatica de prontuario e numero de acesso.
- Validacao de duplicidade por CPF/prontuario.
- Exportacao de dados (PDF, Excel e JSON).
- Importacao de backup.
- Modo offline com `data/*.json` quando o banco estiver indisponivel.
- Sincronizacao automatica do JSON local para MongoDB quando a conexao retorna.
- Historico de paciente em Agendamento e Registros.
- Controle de ponto e livro de ocorrencias.

## Tecnologias Utilizadas

### Aplicacao
- Electron
- Node.js
- JavaScript (ES6+)

### Banco e Persistencia
- MongoDB Driver (`mongodb`)
- dotenv
- JSON local (`data/*.json`) como fallback offline

### Relatorios e Utilitarios
- PDFKit
- xlsx-js-style
- Chart.js

## Estrutura do Projeto

```text
Registro-de-Pacientes/
|
|-- main.js
|-- preload.js
|-- src/
|   |-- pages/
|   |   |-- index.html
|   |   |-- agendamento/agendamento.html
|   |   |-- registros/registros.html
|   |   |-- ocorrencias/ocorrencias.html
|   |   `-- ponto/ponto.html
|   |-- scripts/
|   |   |-- index/index.js
|   |   |-- agendamento/agendamento.js
|   |   |-- registros/registros.js
|   |   |-- ocorrencias/ocorrencias.js
|   |   `-- ponto/ponto.js
|   |-- lib/
|   |   |-- registros-logic.js
|   |   |-- ocorrencias-logic.js
|   |   |-- ponto-logic.js
|   |   `-- agendamento-logic.js
|   |-- styles/
|   `-- assets/images/
|-- tests/
|   |-- registros.test.js
|   |-- relatorio.test.js
|   |-- utilitarios.test.js
|   |-- ocorrencias.test.js
|   |-- ponto.test.js
|   `-- agendamento.test.js
`-- data/
    |-- registros.json
    |-- pacientes.json
    |-- agendamentos.json
    |-- medicos_agenda.json
    |-- ocorrencias.json
    |-- ponto.json
    `-- config.json
```

## Como Usar

### Pre-requisitos

- Node.js 20+
- npm
- MongoDB Atlas ou MongoDB local

### Instalacao

1. Clone o repositorio
```bash
git clone https://github.com/Rodrigogfernandes/Registro-de-Pacientes.git
```

2. Entre na pasta
```bash
cd Registro-de-Pacientes
```

3. Instale as dependencias
```bash
npm install
```

4. Configure o `.env`
```env
MONGODB_URI=mongodb+srv://usuario:senha@cluster.mongodb.net/?appName=RegistroDePacientes
MONGODB_DB=RegistroDePacientes
```

### Executar

```bash
npm start
```

### Build (Windows)

```bash
npm run build
```

## Testes

A suite de testes usa **Jest** e exercita a lógica de negócio extraída em [`src/lib/`](src/lib/). Os módulos `src/scripts/*` consomem essa lib, de modo que o que os testes validam é exatamente o que roda no aplicativo.

### Comandos

```bash
npm test               # roda todos os testes
npm run test:watch     # modo watch (re-roda em cada save)
npm run test:coverage  # relatório de cobertura
```

### Status atual

| Métrica         | Valor      |
| --------------- | ---------- |
| Test Suites     | 6 passed   |
| Tests           | 155 passed |
| Tempo médio     | ~1.2s      |
| Cobertura lib   | 95.97% statements · 88.27% branches · 100% functions |

### O que cada arquivo cobre

| Arquivo                        | Foco                                                                 |
| ------------------------------ | -------------------------------------------------------------------- |
| `tests/registros.test.js`      | Pesquisa, filtro avançado, ordenação, paginação, CRUD, mesclagem de importação, CPF/prontuário, sequenciais, normalização |
| `tests/utilitarios.test.js`    | `formatarData`, `formatCsvField`, `validarFormatoImportacao`         |
| `tests/relatorio.test.js`      | Agrupamento mensal e contagem por modalidade (gráficos)              |
| `tests/ocorrencias.test.js`    | SLA por prioridade (Alta/Media/Baixa), prazos, normalização de status |
| `tests/ponto.test.js`          | Cálculo de horas (com virada de dia), validação de registro          |
| `tests/agendamento.test.js`    | Slots disponíveis, conflito de agenda, períodos, datas bloqueadas    |

### Arquitetura de testes

A pasta [`src/lib/`](src/lib/) reúne a lógica pura (sem DOM, sem Electron, sem disco) usada simultaneamente:

- **Pelos scripts do renderer** (`src/scripts/registros/registros.js`, etc.), que importam via `require('../../lib/...')`.
- **Pelos testes** (`tests/*.test.js`), que importam via `require('../src/lib/...')`.

Isso garante uma única fonte de verdade — não há código duplicado entre teste e produção.

## Persistencia Online/Offline

- Online: le e grava no MongoDB.
- Offline: salva e le em `data/*.json`.
- Reconexao: sincroniza automaticamente dados pendentes do JSON local para o banco.

## Regras de Duplicidade

- Pacientes: bloqueio por CPF ou prontuario duplicado.
- Registros: bloqueio de conflito de identidade:
  - mesmo prontuario com CPF diferente
  - mesmo CPF com prontuario diferente
- Validacao considera dados do MongoDB e do backup local.

## Troubleshooting

### Erro SSL/TLS no MongoDB Atlas

Se ocorrer `MongoServerSelectionError` com `TLSV1_ALERT_INTERNAL_ERROR`:

1. Libere seu IP em `Atlas > Network Access`.
2. Verifique credenciais em `Atlas > Database Access`.
3. Teste em outra rede (VPN/proxy/antivirus podem interferir).
4. Teste com `mongosh` para isolar problema de rede:
```bash
mongosh "mongodb+srv://<usuario>:<senha>@<cluster>.mongodb.net/<db>?appName=RegistroDePacientes"
```

### `mongosh` nao reconhecido

No PowerShell:
```powershell
mongosh --version
```

Se nao reconhecer, ajuste o `PATH` para a pasta de instalacao do `mongosh`.

## Contribuindo

1. Faça um fork do projeto.
2. Crie uma branch para sua feature (`git checkout -b feature/minha-feature`).
3. Commit suas alteracoes (`git commit -m "feat: minha feature"`).
4. Push para a branch (`git push origin feature/minha-feature`).
5. Abra um Pull Request.

## Licenca

ISC

## Contato

**Rodrigo G Fernandes**

- Telefone: [+55 (83) 99925-1636](tel:+5583999251636)
- Email: [rodrigo.guedes.f@gmail.com](mailto:rodrigo.guedes.f@gmail.com)
- Localizacao: Joao Pessoa - PB, Brasil
- Site: [rodrigodev.net](https://www.rodrigodev.net/)
- LinkedIn: [rodrigogfernandes](https://www.linkedin.com/in/rodrigogfernandes/)
- GitHub: [Rodrigogfernandes](https://github.com/Rodrigogfernandes)
- Instagram: [@rodrigogfernandes1](https://www.instagram.com/rodrigogfernandes1/)

---

<div align="center">

Desenvolvido por Rodrigo G Fernandes

</div>
