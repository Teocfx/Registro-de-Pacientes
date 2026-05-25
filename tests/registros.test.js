const {
    filtrarPorTexto,
    filtrarAvancado,
    ordenarRegistros,
    mesclarRegistros,
    paginar,
    criarRegistro,
    excluirRegistro,
    extrairAnosDisponiveis,
    cpfSomenteDigitos,
    extrairCpfOuProntuarioLegado,
    obterProximoProntuario,
    obterProximoNumeroAcesso,
    normalizarRegistro
} = require('../src/lib/registros-logic');

const fixtures = [
    { id: 1, nomePaciente: 'Ana Souza',     modalidade: 'TC',  observacoes: 'Tórax',   numeroAcesso: 'A100', dataHoraExame: '2025-03-10T08:00', nomeTecnico: 'João' },
    { id: 2, nomePaciente: 'Bruno Lima',    modalidade: 'RM',  observacoes: 'Crânio',  numeroAcesso: 'A101', dataHoraExame: '2025-06-15T09:30', nomeTecnico: 'Maria' },
    { id: 3, nomePaciente: 'Carla Mendes',  modalidade: 'TC',  observacoes: 'Abdômen', numeroAcesso: 'A102', dataHoraExame: '2024-12-20T14:00', nomeTecnico: 'João' },
    { id: 4, nomePaciente: 'Diego Pereira', modalidade: 'RX',  observacoes: 'Joelho',  numeroAcesso: 'A103', dataHoraExame: '2026-01-05T07:45', nomeTecnico: 'Paula' }
];

describe('Pesquisa por texto', () => {
    test('retorna todos quando texto vazio', () => {
        expect(filtrarPorTexto(fixtures, '')).toHaveLength(4);
    });

    test('filtra por nome do paciente (case-insensitive)', () => {
        const r = filtrarPorTexto(fixtures, 'bruno');
        expect(r).toHaveLength(1);
        expect(r[0].id).toBe(2);
    });

    test('filtra por número de acesso', () => {
        expect(filtrarPorTexto(fixtures, 'A102')).toHaveLength(1);
    });

    test('filtra por técnico encontrando múltiplos', () => {
        const r = filtrarPorTexto(fixtures, 'joão');
        expect(r.map(x => x.id).sort()).toEqual([1, 3]);
    });

    test('retorna vazio quando nada corresponde', () => {
        expect(filtrarPorTexto(fixtures, 'inexistente')).toEqual([]);
    });

    test('entrada null devolve lista vazia sem lançar', () => {
        expect(filtrarPorTexto(null, 'qualquer')).toEqual([]);
    });
});

describe('Filtro avançado', () => {
    test('filtra apenas por modalidade', () => {
        const r = filtrarAvancado(fixtures, { modalidade: 'TC' });
        expect(r.map(x => x.id).sort()).toEqual([1, 3]);
    });

    test('filtra por intervalo de data', () => {
        const r = filtrarAvancado(fixtures, {
            inicio: '2025-01-01T00:00',
            fim:    '2025-12-31T23:59'
        });
        expect(r.map(x => x.id).sort()).toEqual([1, 2]);
    });

    test('filtra apenas por data de início (sem fim)', () => {
        const r = filtrarAvancado(fixtures, { inicio: '2025-06-01T00:00' });
        expect(r.map(x => x.id).sort()).toEqual([2, 4]);
    });

    test('filtra apenas por data de fim (sem início)', () => {
        const r = filtrarAvancado(fixtures, { fim: '2025-01-01T00:00' });
        expect(r.map(x => x.id)).toEqual([3]);
    });

    test('combina modalidade e intervalo', () => {
        const r = filtrarAvancado(fixtures, {
            modalidade: 'TC',
            inicio: '2024-01-01T00:00',
            fim:    '2025-01-01T00:00'
        });
        expect(r).toHaveLength(1);
        expect(r[0].id).toBe(3);
    });

    test('sem filtros retorna todos', () => {
        expect(filtrarAvancado(fixtures, {})).toHaveLength(4);
    });

    test('sem parâmetro retorna todos', () => {
        expect(filtrarAvancado(fixtures)).toHaveLength(4);
    });
});

describe('Ordenação', () => {
    test('ordena ascendente por nome do paciente', () => {
        const r = ordenarRegistros(fixtures, 'nomePaciente', 'asc');
        expect(r.map(x => x.nomePaciente)).toEqual([
            'Ana Souza', 'Bruno Lima', 'Carla Mendes', 'Diego Pereira'
        ]);
    });

    test('ordena descendente por data', () => {
        const r = ordenarRegistros(fixtures, 'dataHoraExame', 'desc');
        expect(r.map(x => x.id)).toEqual([4, 2, 1, 3]);
    });

    test('ordena ascendente por data', () => {
        const r = ordenarRegistros(fixtures, 'dataHoraExame', 'asc');
        expect(r.map(x => x.id)).toEqual([3, 1, 2, 4]);
    });

    test('não mexe no array original', () => {
        const original = [...fixtures];
        ordenarRegistros(fixtures, 'nomePaciente', 'asc');
        expect(fixtures).toEqual(original);
    });

    test('lida com campo ausente em alguns registros (asc)', () => {
        const dados = [
            { id: 1, modalidade: 'TC' },
            { id: 2 },
            { id: 3, modalidade: 'RX' }
        ];
        const r = ordenarRegistros(dados, 'modalidade', 'asc');
        // O ausente vira string vazia e fica primeiro; 'rx' vem antes de 'tc'.
        expect(r.map(x => x.id)).toEqual([2, 3, 1]);
    });
});

describe('Criação e exclusão de registro', () => {
    test('cria registro novo com id baseado em Date.now', () => {
        const dados = {
            nomePaciente: '  José  ',
            modalidade: 'US',
            observacoes: ' OBS ',
            numeroAcesso: ' A200 ',
            dataHoraExame: '2026-02-01T10:00',
            nomeTecnico: ' Lucas '
        };
        const r = criarRegistro(dados);
        expect(r.nomePaciente).toBe('José');
        expect(r.observacoes).toBe('OBS');
        expect(r.numeroAcesso).toBe('A200');
        expect(r.nomeTecnico).toBe('Lucas');
        expect(typeof r.id).toBe('number');
    });

    test('preserva id ao editar registro existente', () => {
        const existente = fixtures[0];
        const editado = criarRegistro({
            ...existente, nomePaciente: 'Ana Modificada'
        }, existente);
        expect(editado.id).toBe(existente.id);
        expect(editado.nomePaciente).toBe('Ana Modificada');
    });

    test('campos ausentes viram strings vazias', () => {
        const r = criarRegistro({});
        expect(r.nomePaciente).toBe('');
        expect(r.modalidade).toBe('');
        expect(r.observacoes).toBe('');
        expect(r.numeroAcesso).toBe('');
        expect(r.nomeTecnico).toBe('');
        expect(typeof r.id).toBe('number');
    });

    test('exclui o registro pelo id', () => {
        const r = excluirRegistro(fixtures, 2);
        expect(r).toHaveLength(3);
        expect(r.find(x => x.id === 2)).toBeUndefined();
    });

    test('exclusão de id inexistente preserva o array', () => {
        expect(excluirRegistro(fixtures, 999)).toHaveLength(4);
    });
});

describe('Importação - mesclagem de registros', () => {
    test('adiciona somente registros com IDs novos', () => {
        const novos = [
            { id: 2, nomePaciente: 'Duplicado' },
            { id: 99, nomePaciente: 'Novo' }
        ];
        const r = mesclarRegistros(fixtures, novos);
        expect(r).toHaveLength(5);
        expect(r.find(x => x.id === 99)).toBeDefined();
        expect(r.find(x => x.id === 2).nomePaciente).toBe('Bruno Lima');
    });

    test('mesclar array vazio não altera os registros', () => {
        expect(mesclarRegistros(fixtures, [])).toHaveLength(4);
    });

    test('mesclar em base vazia traz todos os novos', () => {
        const novos = [{ id: 1 }, { id: 2 }];
        expect(mesclarRegistros([], novos)).toHaveLength(2);
    });

    test('todos os IDs colidem - mantém base inalterada', () => {
        const colisao = fixtures.map(r => ({ id: r.id, nomePaciente: 'X' }));
        const r = mesclarRegistros(fixtures, colisao);
        expect(r).toHaveLength(4);
        expect(r[0].nomePaciente).toBe('Ana Souza');
    });
});

describe('Paginação', () => {
    test('exibe apenas a página inicial', () => {
        const r = paginar(fixtures, 2, 1);
        expect(r.itens).toHaveLength(2);
        expect(r.exibidos).toBe(2);
        expect(r.total).toBe(4);
        expect(r.temMais).toBe(true);
    });

    test('última página marca temMais=false', () => {
        const r = paginar(fixtures, 2, 2);
        expect(r.exibidos).toBe(4);
        expect(r.temMais).toBe(false);
    });

    test('página maior que o total não estoura', () => {
        const r = paginar(fixtures, 10, 5);
        expect(r.exibidos).toBe(4);
        expect(r.temMais).toBe(false);
    });

    test('lista vazia', () => {
        const r = paginar([], 10, 1);
        expect(r.itens).toEqual([]);
        expect(r.exibidos).toBe(0);
        expect(r.total).toBe(0);
        expect(r.temMais).toBe(false);
    });

    test('paginaAtual=0 é tratado como 1', () => {
        const r = paginar(fixtures, 2, 0);
        expect(r.exibidos).toBe(2);
    });
});

describe('Anos disponíveis para o gráfico', () => {
    test('extrai anos únicos em ordem decrescente', () => {
        expect(extrairAnosDisponiveis(fixtures)).toEqual(['2026', '2025', '2024']);
    });

    test('ignora registros com data inválida', () => {
        const comInvalido = [...fixtures, { id: 5, dataHoraExame: 'data-quebrada' }];
        expect(extrairAnosDisponiveis(comInvalido)).toEqual(['2026', '2025', '2024']);
    });

    test('retorna lista vazia quando não há registros', () => {
        expect(extrairAnosDisponiveis([])).toEqual([]);
    });

    test('aceita null/undefined sem lançar', () => {
        expect(extrairAnosDisponiveis(null)).toEqual([]);
        expect(extrairAnosDisponiveis(undefined)).toEqual([]);
    });
});

describe('CPF e prontuário', () => {
    test('cpfSomenteDigitos remove tudo que não é dígito', () => {
        expect(cpfSomenteDigitos('123.456.789-09')).toBe('12345678909');
        expect(cpfSomenteDigitos('abc')).toBe('');
        expect(cpfSomenteDigitos(null)).toBe('');
    });

    test('extrairCpfOuProntuarioLegado reconhece prontuário no formato Pxxxxxx', () => {
        const r = extrairCpfOuProntuarioLegado('p001234');
        expect(r.prontuarioPaciente).toBe('P001234');
        expect(r.cpfPaciente).toBe('');
    });

    test('extrairCpfOuProntuarioLegado reconhece CPF de 11 dígitos', () => {
        const r = extrairCpfOuProntuarioLegado('123.456.789-09');
        expect(r.cpfPaciente).toBe('12345678909');
        expect(r.prontuarioPaciente).toBe('');
    });

    test('extrairCpfOuProntuarioLegado retorna vazio para entrada vazia', () => {
        expect(extrairCpfOuProntuarioLegado('')).toEqual({ cpfPaciente: '', prontuarioPaciente: '' });
        expect(extrairCpfOuProntuarioLegado(null)).toEqual({ cpfPaciente: '', prontuarioPaciente: '' });
    });

    test('valor não-CPF e não-prontuário cai como prontuário em uppercase', () => {
        const r = extrairCpfOuProntuarioLegado('ab12');
        expect(r.prontuarioPaciente).toBe('AB12');
    });
});

describe('Sequenciais de prontuário e acesso', () => {
    test('obterProximoProntuario gera P000001 quando não há nada', () => {
        expect(obterProximoProntuario([], [])).toBe('P000001');
    });

    test('obterProximoProntuario incrementa baseado no maior existente', () => {
        const pacientes = [{ prontuarioPaciente: 'P000005' }];
        const registros = [{ prontuarioPaciente: 'P000012' }];
        expect(obterProximoProntuario(pacientes, registros)).toBe('P000013');
    });

    test('obterProximoProntuario ignora valores que não casam o padrão', () => {
        const pacientes = [{ prontuarioPaciente: 'lixo' }, { prontuarioPaciente: 'P000003' }];
        expect(obterProximoProntuario(pacientes, [])).toBe('P000004');
    });

    test('obterProximoNumeroAcesso gera 0000001 inicialmente', () => {
        expect(obterProximoNumeroAcesso([])).toBe('0000001');
    });

    test('obterProximoNumeroAcesso pula valores ocupados', () => {
        const registros = [{ numeroAcesso: '0000001' }, { numeroAcesso: '0000002' }];
        expect(obterProximoNumeroAcesso(registros)).toBe('0000003');
    });

    test('obterProximoNumeroAcesso ignora não-numéricos', () => {
        const registros = [{ numeroAcesso: 'A100' }, { numeroAcesso: '0000010' }];
        expect(obterProximoNumeroAcesso(registros)).toBe('0000011');
    });
});

describe('normalizarRegistro', () => {
    test('aplica statusExame=Agendado por padrão', () => {
        const r = normalizarRegistro({ nomePaciente: 'X' });
        expect(r.statusExame).toBe('Agendado');
    });

    test('preserva statusExame quando já existe', () => {
        const r = normalizarRegistro({ statusExame: 'Realizado' });
        expect(r.statusExame).toBe('Realizado');
    });

    test('extrai prontuário a partir de documentoPaciente legado', () => {
        const r = normalizarRegistro({ documentoPaciente: 'p000007' });
        expect(r.prontuarioPaciente).toBe('P000007');
        expect(r.documentoPaciente).toBe('P000007');
    });

    test('limpa CPF para apenas dígitos', () => {
        const r = normalizarRegistro({ cpfPaciente: '123.456.789-09' });
        expect(r.cpfPaciente).toBe('12345678909');
    });

    test('aceita registro nulo sem lançar', () => {
        const r = normalizarRegistro(null);
        expect(r.statusExame).toBe('Agendado');
    });
});
