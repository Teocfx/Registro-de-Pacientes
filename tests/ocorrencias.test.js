const {
    toIsoDateOnly,
    normalizarPrioridade,
    obterStatusNormalizado,
    calcularPrazoEfetivo,
    calcularSla
} = require('../src/lib/ocorrencias-logic');

describe('toIsoDateOnly', () => {
    test('extrai apenas a parte da data', () => {
        expect(toIsoDateOnly('2025-06-15T14:30:00')).toBe('2025-06-15');
    });

    test('aceita data sem hora', () => {
        expect(toIsoDateOnly('2025-06-15')).toBe('2025-06-15');
    });

    test('retorna vazio para entrada vazia', () => {
        expect(toIsoDateOnly('')).toBe('');
        expect(toIsoDateOnly(null)).toBe('');
        expect(toIsoDateOnly(undefined)).toBe('');
    });

    test('retorna vazio para string inválida', () => {
        expect(toIsoDateOnly('texto')).toBe('');
    });
});

describe('normalizarPrioridade', () => {
    test('mapeia variações de "alta"', () => {
        expect(normalizarPrioridade('alta')).toBe('Alta');
        expect(normalizarPrioridade('ALTA')).toBe('Alta');
        expect(normalizarPrioridade(' Alta ')).toBe('Alta');
    });

    test('mapeia variações de "baixa"', () => {
        expect(normalizarPrioridade('baixa')).toBe('Baixa');
        expect(normalizarPrioridade('BAIXA')).toBe('Baixa');
    });

    test('fallback é "Media"', () => {
        expect(normalizarPrioridade('media')).toBe('Media');
        expect(normalizarPrioridade('qualquer')).toBe('Media');
        expect(normalizarPrioridade('')).toBe('Media');
        expect(normalizarPrioridade(null)).toBe('Media');
    });
});

describe('obterStatusNormalizado', () => {
    test('lowercase e remove acentos', () => {
        expect(obterStatusNormalizado('Concluído')).toBe('concluido');
        expect(obterStatusNormalizado('EM ANÁLISE')).toBe('em analise');
    });

    test('faz trim', () => {
        expect(obterStatusNormalizado('  Aberto  ')).toBe('aberto');
    });

    test('aceita vazio', () => {
        expect(obterStatusNormalizado('')).toBe('');
        expect(obterStatusNormalizado(null)).toBe('');
    });
});

describe('calcularPrazoEfetivo', () => {
    test('respeita prazo explícito quando informado', () => {
        const r = calcularPrazoEfetivo({
            data: '2025-06-01',
            prazo: '2025-06-30',
            prioridade: 'Alta'
        });
        expect(r).toBe('2025-06-30');
    });

    test('prioridade Alta adiciona 1 dia à data base', () => {
        expect(calcularPrazoEfetivo({ data: '2025-06-15', prioridade: 'Alta' })).toBe('2025-06-16');
    });

    test('prioridade Media adiciona 3 dias', () => {
        expect(calcularPrazoEfetivo({ data: '2025-06-15', prioridade: 'Media' })).toBe('2025-06-18');
    });

    test('prioridade Baixa adiciona 5 dias', () => {
        expect(calcularPrazoEfetivo({ data: '2025-06-15', prioridade: 'Baixa' })).toBe('2025-06-20');
    });

    test('sem data e sem prazo retorna vazio', () => {
        expect(calcularPrazoEfetivo({ prioridade: 'Alta' })).toBe('');
    });

    test('aceita objeto nulo sem lançar', () => {
        expect(calcularPrazoEfetivo(null)).toBe('');
        expect(calcularPrazoEfetivo(undefined)).toBe('');
    });

    test('atravessa virada de mês', () => {
        expect(calcularPrazoEfetivo({ data: '2025-01-30', prioridade: 'Baixa' })).toBe('2025-02-04');
    });
});

describe('calcularSla', () => {
    test('"Concluida" tem prioridade sobre prazo', () => {
        const r = calcularSla({ status: 'Concluído', data: '2024-01-01', prioridade: 'Alta' }, '2026-05-24');
        expect(r).toBe('Concluida');
    });

    test('"Sem prazo" quando não há data nem prazo', () => {
        expect(calcularSla({ status: 'Aberto' }, '2025-06-15')).toBe('Sem prazo');
    });

    test('"Atrasada" quando prazo já passou', () => {
        const r = calcularSla({ status: 'Aberto', data: '2025-01-01', prioridade: 'Alta' }, '2025-06-15');
        expect(r).toBe('Atrasada');
    });

    test('"Vence hoje" quando prazo === hoje', () => {
        const r = calcularSla({ status: 'Aberto', data: '2025-06-14', prioridade: 'Alta' }, '2025-06-15');
        expect(r).toBe('Vence hoje');
    });

    test('"No prazo" quando prazo é futuro', () => {
        const r = calcularSla({ status: 'Aberto', data: '2025-06-15', prioridade: 'Baixa' }, '2025-06-16');
        expect(r).toBe('No prazo');
    });

    test('status com acentos é reconhecido como concluído', () => {
        expect(calcularSla({ status: 'CONCLUÍDO' }, '2025-06-15')).toBe('Concluida');
    });
});
