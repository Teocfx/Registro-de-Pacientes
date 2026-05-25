const {
    slugifyId,
    removerAcentos,
    parseHoraParaMinutos,
    formatarMinutosParaHora,
    obterDataLocalIso,
    obterDatasPeriodo,
    normalizarDatasBloqueadas,
    conflitoDeAgenda,
    gerarHorariosDisponiveis
} = require('../src/lib/agendamento-logic');

describe('slugifyId', () => {
    test('lowercase e troca espaços por hífen', () => {
        expect(slugifyId('Dr Carlos Silva')).toBe('dr-carlos-silva');
    });

    test('remove acentos e caracteres especiais', () => {
        // 'Médico Ç' → diacríticos removidos, espaço vira hífen.
        expect(slugifyId('Médico Ç')).toBe('medico-c');
    });

    test('aceita vazio', () => {
        expect(slugifyId('')).toBe('');
        expect(slugifyId(null)).toBe('');
    });
});

describe('removerAcentos', () => {
    test('remove diacríticos preservando letras', () => {
        expect(removerAcentos('São João')).toBe('Sao Joao');
        expect(removerAcentos('Ângela')).toBe('Angela');
    });

    test('aceita entrada vazia', () => {
        expect(removerAcentos('')).toBe('');
        expect(removerAcentos(null)).toBe('');
    });
});

describe('parseHoraParaMinutos / formatarMinutosParaHora', () => {
    test('converte HH:MM para minutos', () => {
        expect(parseHoraParaMinutos('07:30')).toBe(450);
        expect(parseHoraParaMinutos('00:00')).toBe(0);
    });

    test('formata minutos para HH:MM com zero-padding', () => {
        expect(formatarMinutosParaHora(450)).toBe('07:30');
        expect(formatarMinutosParaHora(0)).toBe('00:00');
        expect(formatarMinutosParaHora(60)).toBe('01:00');
    });

    test('roundtrip preserva valor', () => {
        const hora = '13:45';
        expect(formatarMinutosParaHora(parseHoraParaMinutos(hora))).toBe(hora);
    });

    test('entrada inválida vira 0', () => {
        expect(parseHoraParaMinutos('')).toBe(0);
        expect(parseHoraParaMinutos('xx:yy')).toBe(0);
    });
});

describe('obterDataLocalIso', () => {
    test('formata data como AAAA-MM-DD em horário local', () => {
        const d = new Date(2025, 5, 15); // 15/06/2025 local
        expect(obterDataLocalIso(d)).toBe('2025-06-15');
    });

    test('aceita string parseável', () => {
        const d = new Date('2025-06-15T10:00:00');
        expect(obterDataLocalIso(d)).toBe('2025-06-15');
    });

    test('Date inválido retorna vazio', () => {
        expect(obterDataLocalIso(new Date('xx'))).toBe('');
    });
});

describe('obterDatasPeriodo', () => {
    test('"dia" retorna apenas a data', () => {
        expect(obterDatasPeriodo('dia', '2025-06-15')).toEqual(['2025-06-15']);
    });

    test('"semana" retorna 7 datas começando no domingo', () => {
        const r = obterDatasPeriodo('semana', '2025-06-18'); // quarta
        expect(r).toHaveLength(7);
        expect(r[0]).toBe('2025-06-15'); // domingo
        expect(r[6]).toBe('2025-06-21'); // sábado
    });

    test('"mes" cobre todos os dias do mês de referência', () => {
        const r = obterDatasPeriodo('mes', '2025-06-15');
        expect(r).toHaveLength(30);
        expect(r[0]).toBe('2025-06-01');
        expect(r[29]).toBe('2025-06-30');
    });

    test('"mes" em fevereiro de ano comum tem 28 dias', () => {
        expect(obterDatasPeriodo('mes', '2025-02-10')).toHaveLength(28);
    });

    test('outro período retorna os 12 primeiros dias dos meses do ano', () => {
        const r = obterDatasPeriodo('ano', '2025-06-15');
        expect(r).toHaveLength(12);
        expect(r[0]).toBe('2025-01-01');
        expect(r[11]).toBe('2025-12-01');
    });

    test('data inválida retorna lista vazia', () => {
        expect(obterDatasPeriodo('mes', 'data-quebrada')).toEqual([]);
    });
});

describe('normalizarDatasBloqueadas', () => {
    test('mantém apenas datas no formato ISO e ordena', () => {
        expect(normalizarDatasBloqueadas(['2025-06-20', '2025-01-10', 'lixo']))
            .toEqual(['2025-01-10', '2025-06-20']);
    });

    test('remove duplicatas', () => {
        expect(normalizarDatasBloqueadas(['2025-06-20', '2025-06-20']))
            .toEqual(['2025-06-20']);
    });

    test('aceita não-array', () => {
        expect(normalizarDatasBloqueadas(null)).toEqual([]);
        expect(normalizarDatasBloqueadas('texto')).toEqual([]);
    });
});

describe('conflitoDeAgenda', () => {
    const agendamentos = [
        { id: 1, medicoId: 'ronny', dataHora: '2025-06-15T08:00', statusExame: 'Agendado' },
        { id: 2, medicoId: 'ronny', dataHora: '2025-06-15T09:00', statusExame: 'Cancelado' },
        { id: 3, medicoId: 'germana', dataHora: '2025-06-15T08:00', statusExame: 'Agendado' }
    ];

    test('detecta conflito quando há horário ocupado pelo mesmo médico', () => {
        expect(conflitoDeAgenda(agendamentos, {
            medicoId: 'ronny', dataHora: '2025-06-15T08:00'
        })).toBe(true);
    });

    test('ignora agendamentos cancelados', () => {
        expect(conflitoDeAgenda(agendamentos, {
            medicoId: 'ronny', dataHora: '2025-06-15T09:00'
        })).toBe(false);
    });

    test('médicos diferentes no mesmo horário não conflitam entre si', () => {
        expect(conflitoDeAgenda(agendamentos, {
            medicoId: 'novo', dataHora: '2025-06-15T08:00'
        })).toBe(false);
    });

    test('ignora o próprio agendamento ao editar (ignorarAgendamentoId)', () => {
        expect(conflitoDeAgenda(agendamentos, {
            medicoId: 'ronny', dataHora: '2025-06-15T08:00', ignorarAgendamentoId: 1
        })).toBe(false);
    });

    test('lista vazia nunca conflita', () => {
        expect(conflitoDeAgenda([], { medicoId: 'x', dataHora: 'y' })).toBe(false);
    });
});

describe('gerarHorariosDisponiveis', () => {
    const medico = {
        id: 'ronny',
        diasSemana: [1, 2, 3, 4, 5], // segunda-sexta
        inicio: '08:00',
        fim: '10:00',
        intervaloMinutos: 30,
        datasBloqueadas: []
    };

    test('gera todos os slots dentro do expediente quando agenda livre', () => {
        // 2025-06-16 é segunda-feira
        const slots = gerarHorariosDisponiveis(medico, '2025-06-16', []);
        expect(slots).toEqual(['08:00', '08:30', '09:00', '09:30']);
    });

    test('remove slots já ocupados', () => {
        const agendamentos = [
            { id: 1, medicoId: 'ronny', dataHora: '2025-06-16T09:00', statusExame: 'Agendado' }
        ];
        const slots = gerarHorariosDisponiveis(medico, '2025-06-16', agendamentos);
        expect(slots).toEqual(['08:00', '08:30', '09:30']);
    });

    test('retorna vazio quando data cai fora dos diasSemana', () => {
        // 2025-06-15 é domingo
        expect(gerarHorariosDisponiveis(medico, '2025-06-15', [])).toEqual([]);
    });

    test('retorna vazio em data bloqueada', () => {
        const m = { ...medico, datasBloqueadas: ['2025-06-16'] };
        expect(gerarHorariosDisponiveis(m, '2025-06-16', [])).toEqual([]);
    });

    test('retorna vazio sem médico ou data', () => {
        expect(gerarHorariosDisponiveis(null, '2025-06-16', [])).toEqual([]);
        expect(gerarHorariosDisponiveis(medico, '', [])).toEqual([]);
    });

    test('intervaloMinutos inválido protege contra loop infinito', () => {
        const m = { ...medico, intervaloMinutos: 0 };
        expect(gerarHorariosDisponiveis(m, '2025-06-16', [])).toEqual([]);
    });

    test('fim antes do início retorna vazio', () => {
        const m = { ...medico, inicio: '15:00', fim: '10:00' };
        expect(gerarHorariosDisponiveis(m, '2025-06-16', [])).toEqual([]);
    });
});
