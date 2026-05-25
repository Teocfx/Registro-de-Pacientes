const {
    formatarData,
    formatCsvField,
    validarFormatoImportacao
} = require('../src/lib/registros-logic');

describe('formatarData', () => {
    test('retorna string vazia quando entrada vazia', () => {
        expect(formatarData('')).toBe('');
        expect(formatarData(null)).toBe('');
        expect(formatarData(undefined)).toBe('');
    });

    test('retorna "Data inválida" para string inválida', () => {
        expect(formatarData('texto-qualquer')).toBe('Data inválida');
    });

    test('formata data ISO no padrão pt-BR (dd/mm/aaaa hh:mm)', () => {
        const s = formatarData('2025-03-10T08:00');
        expect(s).toMatch(/^\d{2}\/\d{2}\/\d{4}.*\d{2}:\d{2}$/);
        expect(s).toContain('10/03/2025');
    });

    test('aceita instância Date', () => {
        const s = formatarData(new Date('2025-03-10T08:00'));
        expect(s).toContain('10/03/2025');
    });

    test('aceita timestamp numérico', () => {
        const ts = new Date('2025-03-10T08:00').getTime();
        const s = formatarData(ts);
        expect(s).toContain('10/03/2025');
    });
});

describe('formatCsvField', () => {
    test('envolve o valor em aspas', () => {
        expect(formatCsvField('teste', 50)).toBe('"teste"');
    });

    test('converte null/undefined em string vazia entre aspas', () => {
        expect(formatCsvField(null, 50)).toBe('""');
        expect(formatCsvField(undefined, 50)).toBe('""');
    });

    test('escapa aspas duplas internas', () => {
        expect(formatCsvField('com "aspas" aqui', 50)).toBe('"com ""aspas"" aqui"');
    });

    test('substitui vírgulas por ponto-e-vírgula', () => {
        expect(formatCsvField('a,b,c', 50)).toBe('"a;b;c"');
    });

    test('remove quebras de linha', () => {
        expect(formatCsvField('linha1\nlinha2', 50)).toBe('"linha1 linha2"');
        expect(formatCsvField('linha1\r\nlinha2', 50)).toBe('"linha1 linha2"');
    });

    test('trunca quando excede o tamanho máximo', () => {
        const r = formatCsvField('abcdefghij', 8);
        expect(r).toBe('"abcde..."');
    });

    test('sem maxWidth não trunca', () => {
        const longo = 'a'.repeat(200);
        expect(formatCsvField(longo)).toBe(`"${longo}"`);
    });

    test('aceita números convertendo para string', () => {
        expect(formatCsvField(42, 10)).toBe('"42"');
    });
});

describe('validarFormatoImportacao', () => {
    test('aceita array com registros válidos', () => {
        const dados = [
            { nomePaciente: 'A', modalidade: 'TC', numeroAcesso: '1' },
            { nomePaciente: 'B', modalidade: 'RM', numeroAcesso: '2' }
        ];
        expect(validarFormatoImportacao(dados)).toBe(true);
    });

    test('rejeita quando não é array', () => {
        expect(validarFormatoImportacao('texto')).toBe(false);
        expect(validarFormatoImportacao(null)).toBe(false);
        expect(validarFormatoImportacao({})).toBe(false);
    });

    test('rejeita array vazio', () => {
        expect(validarFormatoImportacao([])).toBe(false);
    });

    test('rejeita quando falta algum campo obrigatório', () => {
        const dados = [{ nomePaciente: 'A', modalidade: 'TC' }];
        expect(validarFormatoImportacao(dados)).toBe(false);
    });

    test('rejeita quando algum item é null', () => {
        const dados = [
            { nomePaciente: 'A', modalidade: 'TC', numeroAcesso: '1' },
            null
        ];
        expect(validarFormatoImportacao(dados)).toBe(false);
    });
});
