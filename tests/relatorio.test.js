const {
    agruparPorMes,
    contarPorModalidade,
    MESES_PT
} = require('../src/lib/registros-logic');

const fixtures = [
    { id: 1, modalidade: 'TC', dataHoraExame: '2025-01-10T08:00' },
    { id: 2, modalidade: 'TC', dataHoraExame: '2025-01-25T09:00' },
    { id: 3, modalidade: 'RM', dataHoraExame: '2025-03-05T10:00' },
    { id: 4, modalidade: 'RX', dataHoraExame: '2025-12-31T23:30' },
    { id: 5, modalidade: 'TC', dataHoraExame: '2024-06-15T09:00' },
    { id: 6, modalidade: null, dataHoraExame: '2025-03-15T11:00' }
];

describe('agruparPorMes', () => {
    test('conta corretamente por mês para o ano filtrado', () => {
        const r = agruparPorMes(fixtures, '2025');
        expect(r.Janeiro).toBe(2);
        expect(r.Março).toBe(2);
        expect(r.Dezembro).toBe(1);
        expect(r.Junho).toBe(0); // o de 2024 não entra
    });

    test('sem ano agrupa todos os meses de todos os anos', () => {
        const r = agruparPorMes(fixtures);
        expect(r.Junho).toBe(1);
        expect(r.Janeiro).toBe(2);
    });

    test('todos os 12 meses estão presentes mesmo com zero', () => {
        const r = agruparPorMes(fixtures, '2025');
        MESES_PT.forEach(m => expect(r).toHaveProperty(m));
    });

    test('ignora data inválida', () => {
        const r = agruparPorMes([{ dataHoraExame: 'invalida' }], '2025');
        expect(Object.values(r).reduce((s, v) => s + v, 0)).toBe(0);
    });

    test('aceita lista vazia / null', () => {
        expect(Object.values(agruparPorMes([])).reduce((s, v) => s + v, 0)).toBe(0);
        expect(Object.values(agruparPorMes(null)).reduce((s, v) => s + v, 0)).toBe(0);
    });

    test('ano como número também funciona', () => {
        const r = agruparPorMes(fixtures, 2025);
        expect(r.Janeiro).toBe(2);
    });
});

describe('contarPorModalidade', () => {
    test('conta corretamente cada modalidade', () => {
        const r = contarPorModalidade(fixtures);
        expect(r.TC).toBe(3);
        expect(r.RM).toBe(1);
        expect(r.RX).toBe(1);
    });

    test('agrupa nulos em "Não especificado"', () => {
        const r = contarPorModalidade(fixtures);
        expect(r['Não especificado']).toBe(1);
    });

    test('lista vazia retorna objeto vazio', () => {
        expect(contarPorModalidade([])).toEqual({});
    });

    test('aceita null', () => {
        expect(contarPorModalidade(null)).toEqual({});
    });
});
