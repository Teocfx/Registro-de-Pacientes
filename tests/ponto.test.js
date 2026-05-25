const {
    parseHora,
    calcularHorasTrabalhadas,
    calcularHorasDoRegistro,
    validarRegistro,
    filtrarRegistrosPorMes
} = require('../src/lib/ponto-logic');

describe('parseHora', () => {
    test('converte HH:MM em minutos', () => {
        expect(parseHora('08:30')).toBe(8 * 60 + 30);
        expect(parseHora('00:00')).toBe(0);
        expect(parseHora('23:59')).toBe(23 * 60 + 59);
    });

    test('aceita hora com um dígito', () => {
        expect(parseHora('9:05')).toBe(9 * 60 + 5);
    });

    test('rejeita formato inválido', () => {
        expect(parseHora('25:00')).toBeNull();
        expect(parseHora('12:60')).toBeNull();
        expect(parseHora('12')).toBeNull();
        expect(parseHora('')).toBeNull();
        expect(parseHora(null)).toBeNull();
    });
});

describe('calcularHorasTrabalhadas', () => {
    test('calcula intervalo simples', () => {
        expect(calcularHorasTrabalhadas('08:00', '12:00')).toBe(4);
    });

    test('calcula com minutos', () => {
        expect(calcularHorasTrabalhadas('08:30', '12:00')).toBe(3.5);
    });

    test('retorna 0 quando algum lado está vazio', () => {
        expect(calcularHorasTrabalhadas('', '12:00')).toBe(0);
        expect(calcularHorasTrabalhadas('08:00', '')).toBe(0);
        expect(calcularHorasTrabalhadas(null, '12:00')).toBe(0);
    });

    test('retorna 0 para entradas inválidas', () => {
        expect(calcularHorasTrabalhadas('xx', '12:00')).toBe(0);
    });

    test('lida com virada de dia (saída < entrada)', () => {
        expect(calcularHorasTrabalhadas('22:00', '02:00')).toBe(4);
    });
});

describe('calcularHorasDoRegistro', () => {
    test('soma manhã e tarde', () => {
        const r = {
            turno_manha_entrada: '08:00',
            turno_manha_saida: '12:00',
            turno_tarde_entrada: '13:00',
            turno_tarde_saida: '17:00'
        };
        expect(calcularHorasDoRegistro(r)).toBe(8);
    });

    test('apenas manhã preenchida', () => {
        expect(calcularHorasDoRegistro({
            turno_manha_entrada: '08:00',
            turno_manha_saida: '11:30'
        })).toBe(3.5);
    });

    test('registro vazio retorna 0', () => {
        expect(calcularHorasDoRegistro({})).toBe(0);
        expect(calcularHorasDoRegistro(null)).toBe(0);
    });
});

describe('validarRegistro', () => {
    test('rejeita sem data', () => {
        const r = validarRegistro({ turno_manha_entrada: '08:00' });
        expect(r.ok).toBe(false);
        expect(r.mensagem).toMatch(/Data/);
    });

    test('rejeita sem nenhum turno', () => {
        const r = validarRegistro({ data: '2025-06-15' });
        expect(r.ok).toBe(false);
        expect(r.mensagem).toMatch(/turno/i);
    });

    test('aceita com data + manhã', () => {
        const r = validarRegistro({ data: '2025-06-15', turno_manha_entrada: '08:00' });
        expect(r.ok).toBe(true);
    });

    test('aceita com data + tarde', () => {
        const r = validarRegistro({ data: '2025-06-15', turno_tarde_entrada: '13:00' });
        expect(r.ok).toBe(true);
    });

    test('rejeita null/undefined com mensagem amigável', () => {
        expect(validarRegistro(null).ok).toBe(false);
        expect(validarRegistro(undefined).ok).toBe(false);
    });
});

describe('filtrarRegistrosPorMes', () => {
    const registros = [
        { data: '2025-06-01' },
        { data: '2025-06-15' },
        { data: '2025-07-10' },
        { data: '' }
    ];

    test('filtra pelo prefixo AAAA-MM', () => {
        const r = filtrarRegistrosPorMes(registros, '2025-06');
        expect(r).toHaveLength(2);
    });

    test('sem mês retorna cópia da lista', () => {
        const r = filtrarRegistrosPorMes(registros, '');
        expect(r).toHaveLength(4);
    });

    test('lista vazia / null', () => {
        expect(filtrarRegistrosPorMes([], '2025-06')).toEqual([]);
        expect(filtrarRegistrosPorMes(null, '2025-06')).toEqual([]);
    });
});
