// Importar módulos do Node.js
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
// Variáveis globais
let funcionarios = [];
let registros = [];
let funcionarioSelecionado = null;
let adminMode = false;
let currentSession = null;

// Função para aplicar tema (definida no início para garantir que seja executada primeiro)
function setTheme(theme) {
    if (typeof document !== 'undefined') {
        // Aplicar tanto no body quanto no html para garantir
        if (document.body) {
            document.body.classList.remove('dark-theme', 'theme-azul');
        }
        if (document.documentElement) {
            document.documentElement.classList.remove('dark-theme', 'theme-azul');
        }
        
        if (theme === 'dark') {
            if (document.body) document.body.classList.add('dark-theme');
            if (document.documentElement) document.documentElement.classList.add('dark-theme');
        } else if (theme === 'blue' || theme === 'azul') {
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
            const savedTheme = localStorage.getItem('theme');
            if (savedTheme) {
                setTheme(savedTheme);
            }
        }
    } catch (error) {
        console.error('Erro ao carregar tema:', error);
    }
}

// Executar carregamento do tema imediatamente (quando o script é carregado)
// O tema já foi aplicado no HTML, mas vamos garantir que está correto
loadTheme();

// Funções para comunicação com o processo principal via IPC
// Os dados são gerenciados através dos handlers IPC no main.js

// Abrir modal
function openModal(modalId) {
  const modal = document.getElementById(`modal-${modalId}`);
  const overlay = document.getElementById('overlay');
  
  if (modal) {
    // Fechar outros modais primeiro
    document.querySelectorAll('.modal.active').forEach(m => {
      m.classList.remove('active');
    });
    
    modal.classList.add('active');
    if (overlay) {
      overlay.classList.add('active');
    }

    // Se for o modal de bater ponto, definir data padrão
    if (modalId === 'bater-ponto') {
      const dataInput = modal.querySelector('input[name="data"]');
      if (dataInput && !dataInput.value) {
        const hoje = new Date();
        const ano = hoje.getFullYear();
        const mes = String(hoje.getMonth() + 1).padStart(2, '0');
        const dia = String(hoje.getDate()).padStart(2, '0');
        dataInput.value = `${ano}-${mes}-${dia}`;
      }
    }

    // Focar no primeiro input do modal
    const firstInput = modal.querySelector('input');
    if (firstInput) {
      setTimeout(() => {
        firstInput.focus();
      }, 100);
    }
  }
}

// Fechar modal
function closeModal() {
  const modals = document.querySelectorAll('.modal');
  const overlay = document.getElementById('overlay');
  
  modals.forEach(modal => {
    modal.classList.remove('active');
  });
  
  if (overlay) {
    overlay.classList.remove('active');
  }

  // Remover o foco de qualquer elemento
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

// Carregar dados automaticamente ao iniciar
async function loadDados() {
    try {
        console.log('Carregando dados do arquivo ponto.json...');
        
        // Usar IPC para ler os dados
        const dados = await ipcRenderer.invoke('ler-ponto');
        
        funcionarios = dados.funcionarios || [];
        registros = dados.registros || [];
        
        updateUI();
        setDefaultMonth();
    } catch (error) {
        console.error('Erro ao carregar dados:', error);
        funcionarios = [];
        registros = [];
        updateUI();
    }
}

// Salvar dados automaticamente
async function saveDados() {
    try {
        const dados = { funcionarios, registros };
        const sucesso = await ipcRenderer.invoke('salvar-ponto', dados);
        if (sucesso) {
            filtrarPorMes();
        } else {
            showModalMessage('Erro ao salvar dados');
        }
    } catch (error) {
        console.error('Erro ao salvar dados:', error);
        showModalMessage('Erro ao salvar dados');
    }
}

// Atualizar interface com os dados carregados
function updateUI() {
  const funcionariosList = document.getElementById('funcionarios-list');
  funcionariosList.innerHTML = '';

  funcionarios.forEach(func => {
    const li = document.createElement('li');
    li.textContent = func.nome;
    
    // Adicionar classe de destaque apropriada
    if (func.id === funcionarioSelecionado) {
      if (adminMode) {
        li.classList.add('admin-selecionado');
      } else {
        li.classList.add('selecionado');
      }
    }
    
    li.onclick = () => selecionarFuncionario(func.id);
    li.ondblclick = () => openModalEditarExcluirFuncionario(func);
    funcionariosList.appendChild(li);
  });

  renderRegistrosTable();
}

// Função para mostrar mensagem em modal
function showModalMessage(message, title = 'Aviso') {
    const modal = document.getElementById('modal-mensagem');
    const mensagemTitulo = document.getElementById('mensagem-titulo');
    const mensagemTexto = document.getElementById('mensagem-texto');
    
    mensagemTitulo.textContent = title;
    mensagemTexto.textContent = message;
    
    openModal('mensagem');
}

// Selecionar funcionário
function selecionarFuncionario(id) {
    const funcionario = funcionarios.find(f => f.id === id);
    if (!funcionario) return;

    // Se clicar no funcionário já selecionado
    if (funcionarioSelecionado === id) {
        if (adminMode) {
            // Desselecionar no modo admin
            funcionarioSelecionado = null;
            document.getElementById('titulo-registro-ponto').textContent = 'Registros de Ponto';
            
            // Remover botão de alterar senha
            const btnAlterarSenha = document.getElementById('btn-alterar-senha');
            if (btnAlterarSenha) {
                btnAlterarSenha.remove();
            }
            
            updateUI();
            filtrarPorMes();
            return;
        } else {
            openModal('opcoes-funcionario');
            return;
        }
    }

    if (adminMode) {
        // Se estiver em modo admin, apenas seleciona o funcionário
        funcionarioSelecionado = id;
        document.getElementById('titulo-registro-ponto').textContent = `Registros de ${funcionario.nome}`;
        
        // Adicionar botão de alterar senha
        const btnContainer = document.querySelector('.content');
        if (!document.getElementById('btn-alterar-senha')) {
            const btnAlterarSenha = document.createElement('button');
            btnAlterarSenha.id = 'btn-alterar-senha';
            btnAlterarSenha.textContent = 'Alterar Senha';
            btnAlterarSenha.onclick = () => openModal('alterar-senha');
            btnContainer.insertBefore(btnAlterarSenha, document.getElementById('btn-exportar-pdf'));
        }
        
        updateUI();
        filtrarPorMes();
        return;
    }

    // Abrir modal de verificação de senha
    const modal = document.getElementById('modal-verificar-senha');
    const form = document.getElementById('form-verificar-senha');
    let tentativas = 1;
    
    form.onsubmit = function(e) {
        e.preventDefault();
        const senhaDigitada = form.senha.value;
        
        // Verificar senha do funcionário ou do admin
        if (senhaDigitada === funcionario.senha) {
            funcionarioSelecionado = id;
            document.getElementById('titulo-registro-ponto').textContent = `Registros de ${funcionario.nome}`;
            document.getElementById('btn-bater-ponto').style.display = 'inline-block';
            
            // Adicionar botão de alterar senha
            const btnContainer = document.querySelector('.content');
            if (!document.getElementById('btn-alterar-senha')) {
                const btnAlterarSenha = document.createElement('button');
                btnAlterarSenha.id = 'btn-alterar-senha';
                btnAlterarSenha.textContent = 'Alterar Senha';
                btnAlterarSenha.onclick = () => openModal('alterar-senha');
                btnContainer.insertBefore(btnAlterarSenha, document.getElementById('btn-exportar-pdf'));
            }
            
            closeModal();
            updateUI();
            filtrarPorMes();
        } else {
            tentativas++;
            if (tentativas >= 1) {
                showModalMessage('Número máximo de tentativas excedido.');
                closeModal();
                inicializarPagina();
            } else {
                showModalMessage(`Senha incorreta! Tentativa ${tentativas} de 1`);
            }
        }
        form.reset();
    };
    
    openModal('verificar-senha');
}

// Filtrar registros por mês
function filtrarPorMes() {
  // Verificar se há funcionário selecionado
  if (!funcionarioSelecionado) {
    renderRegistrosTable([]);
    return;
  }
  
  const mesSelecionadoInput = document.getElementById('mes-selecionado');
  if (!mesSelecionadoInput) {
    renderRegistrosTable([]);
    return;
  }
  
  const mesSelecionado = mesSelecionadoInput.value;
  if (!mesSelecionado) {
    renderRegistrosTable([]);
    return;
  }
  
  // Validar formato do mês selecionado (YYYY-MM)
  const mesRegex = /^\d{4}-\d{2}$/;
  if (!mesRegex.test(mesSelecionado)) {
    console.error('Formato de mês inválido:', mesSelecionado);
    renderRegistrosTable([]);
    return;
  }
  
  const [ano, mes] = mesSelecionado.split('-');
  const anoInt = parseInt(ano, 10);
  const mesInt = parseInt(mes, 10);
  
  // Validar valores
  if (isNaN(anoInt) || isNaN(mesInt) || mesInt < 1 || mesInt > 12) {
    console.error('Valores de ano/mês inválidos:', anoInt, mesInt);
    renderRegistrosTable([]);
    return;
  }
  
  const registrosFiltrados = registros.filter(r => {
    // Verificar se o registro pertence ao funcionário selecionado
    if (r.funcionario_id !== funcionarioSelecionado) {
      return false;
    }
    
    // Comparar diretamente a string da data sem usar new Date() para evitar problemas de fuso horário
    if (!r.data || typeof r.data !== 'string') {
      return false;
    }
    
    // Validar formato da data (YYYY-MM-DD)
    const dataRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dataRegex.test(r.data)) {
      console.warn('Formato de data inválido no registro:', r.data);
      return false;
    }
    
    // Extrair ano e mês da string de data (formato: YYYY-MM-DD)
    const partesData = r.data.split('-');
    if (partesData.length !== 3) {
      return false;
    }
    
    const registroAno = parseInt(partesData[0], 10);
    const registroMes = parseInt(partesData[1], 10);
    
    // Validar valores extraídos
    if (isNaN(registroAno) || isNaN(registroMes) || registroMes < 1 || registroMes > 12) {
      return false;
    }
    
    // Comparar ano e mês diretamente
    return registroAno === anoInt && registroMes === mesInt;
  });
  
  // Ordenar registros por data (do mais antigo para o mais recente)
  registrosFiltrados.sort((a, b) => {
    if (a.data < b.data) return -1;
    if (a.data > b.data) return 1;
    return 0;
  });
  
  renderRegistrosTable(registrosFiltrados); // Renderiza a tabela com os registros filtrados
}

// Renderizar tabela de registros
function renderRegistrosTable(registrosFiltrados = []) {
  const tbody = document.querySelector('#registros-table tbody');
  if (!tbody) {
    console.error('Elemento tbody não encontrado');
    return;
  }
  
  tbody.innerHTML = '';
  let totalAReceber = 0;

  if (registrosFiltrados.length === 0) {
    // Mostrar mensagem quando não há registros
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td colspan="6" style="text-align: center; padding: 20px; color: #666;">
        ${!funcionarioSelecionado ? 'Selecione um funcionário para ver os registros' : 'Nenhum registro encontrado para o período selecionado'}
      </td>
    `;
    tbody.appendChild(tr);
  } else {
    registrosFiltrados.forEach(registro => {
      // Validar dados do registro
      if (!registro || !registro.data) {
        console.warn('Registro inválido:', registro);
        return;
      }
      
      // Formatar data para exibição (DD/MM/YYYY)
      const partesData = registro.data.split('-');
      const dataFormatada = partesData.length === 3 
        ? `${partesData[2]}/${partesData[1]}/${partesData[0]}`
        : registro.data;
      
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${dataFormatada}</td>
        <td>${registro.turno_manha_entrada || '-'} - ${registro.turno_manha_saida || '-'}</td>
        <td>${registro.turno_tarde_entrada || '-'} - ${registro.turno_tarde_saida || '-'}</td>
        <td>${registro.horas_extras || 0}</td>
        <td>${(registro.total_horas_trabalhadas || 0).toFixed(2)}</td>
        <td>R$ ${(registro.valor_diario || 0).toFixed(2)}</td>
      `;
      tr.ondblclick = () => openModalEditarRegistro(registro);
      tbody.appendChild(tr);
      totalAReceber += registro.valor_diario || 0;
    });
  }

  const totalElement = document.getElementById('total-a-receber');
  if (totalElement) {
    totalElement.textContent = `R$ ${totalAReceber.toFixed(2)}`;
  }
}

// Abrir modal de edição/exclusão de funcionário
function openModalEditarExcluirFuncionario(func) {
  if (!adminMode) {
    showModalMessage('Apenas administradores podem editar funcionários');
    return;
  }
  funcionarioSelecionado = func.id;

  // Preenche os dados do funcionário no modal
  const modal = document.getElementById('modal-editar-excluir-funcionario');
  modal.querySelector('.funcionario-nome').textContent = func.nome;
  modal.querySelector('.funcionario-cpf').textContent = func.cpf;
  modal.querySelector('.funcionario-valor-hora').textContent = func.valor_hora;
  modal.querySelector('.funcionario-multiplicador-extra').textContent = func.multiplicador_extra;

  // Configura os botões de editar e excluir
  const btnEditar = modal.querySelector('#btn-editar-funcionario');
  const btnExcluir = modal.querySelector('#btn-excluir-funcionario');

  btnEditar.onclick = () => {
    closeModal(); // Fecha o modal de edição/exclusão
    openModalEditarFuncionario(func); // Abre o modal de edição
  };

  btnExcluir.onclick = excluirFuncionarioConfirm;

  // Abre o modal de edição/exclusão
  openModal('editar-excluir-funcionario');
}

// Editar funcionário
function openModalEditarFuncionario(func) {
  const form = document.getElementById('form-editar-funcionario');
  form.nome.value = func.nome;
  form.cpf.value = func.cpf;
  form.valor_hora.value = func.valor_hora;
  form.multiplicador_extra.value = func.multiplicador_extra;
  form.carga_horaria.value = func.carga_horaria || 6;

  form.onsubmit = function(e) {
    e.preventDefault();
    func.nome = form.nome.value;
    func.cpf = form.cpf.value;
    func.valor_hora = parseFloat(form.valor_hora.value);
    func.multiplicador_extra = parseFloat(form.multiplicador_extra.value);
    func.carga_horaria = parseFloat(form.carga_horaria.value);
    saveDados();
    closeModal();
    updateUI();
  };

  openModal('editar-funcionario'); // Abre o modal de edição
}

// Excluir funcionário
// Replace the excluirFuncionarioConfirm function with:
function excluirFuncionarioConfirm() {
    openModal('confirmar-exclusao-funcionario');
}

// Add this new function
function confirmarExclusaoFuncionario() {
    const func = funcionarios.find(f => f.id === funcionarioSelecionado);
    if (!func) return;

    funcionarios = funcionarios.filter(f => f.id !== func.id);
    registros = registros.filter(r => r.funcionario_id !== func.id);
    saveDados();
    closeModal();
    updateUI();
}

// Adicionar função para alternar campos de horário
function toggleHorarios(select) {
    const container = document.getElementById('horarios-container');
    const inputs = container.getElementsByTagName('input');
    
    switch(select.value) {
        case 'meio':
            // Meio período (padrão 6h)
            inputs.manha_entrada.value = '07:00';
            inputs.manha_saida.value = '13:00';
            inputs.tarde_entrada.value = '';
            inputs.tarde_saida.value = '';
            break;
        case 'integral':
            // Período integral (padrão 8h)
            inputs.manha_entrada.value = '07:00';
            inputs.manha_saida.value = '12:00';
            inputs.tarde_entrada.value = '13:00';
            inputs.tarde_saida.value = '16:00';
            break;
        case 'especial':
            // Limpar campos para entrada manual
            Array.from(inputs).forEach(input => input.value = '');
            break;
    }
}

// Modificar a função configurarEventListeners
function configurarEventListeners() {
    // Configurar formulário de adicionar funcionário
    const formAddFuncionario = document.getElementById('form-add-funcionario');
    if (formAddFuncionario) {
        formAddFuncionario.onsubmit = function(e) {
            e.preventDefault();
            const formData = new FormData(this);
            const novoFuncionario = {
                id: Date.now(),
                nome: formData.get('nome'),
                cpf: formData.get('cpf'),
                valor_hora: parseFloat(formData.get('valor_hora')),
                multiplicador_extra: parseFloat(formData.get('multiplicador_extra')),
                tipo_carga_horaria: formData.get('tipo_carga_horaria'),
                horarios: {
                    manha_entrada: formData.get('manha_entrada'),
                    manha_saida: formData.get('manha_saida'),
                    tarde_entrada: formData.get('tarde_entrada'),
                    tarde_saida: formData.get('tarde_saida')
                },
                senha: formData.get('senha')
            };

            funcionarios.push(novoFuncionario);
            saveDados();
            closeModal();
            updateUI();
            this.reset();
        };
    }

    // Configurar formulário de bater ponto
    const formBaterPonto = document.getElementById('form-bater-ponto');
    if (formBaterPonto) {
        // Definir data padrão ao abrir o modal
        const dataInput = formBaterPonto.querySelector('input[name="data"]');
        if (dataInput) {
            // Definir data padrão como hoje
            const hoje = new Date();
            const ano = hoje.getFullYear();
            const mes = String(hoje.getMonth() + 1).padStart(2, '0');
            const dia = String(hoje.getDate()).padStart(2, '0');
            const dataHoje = `${ano}-${mes}-${dia}`;
            
            // Se o campo estiver vazio, preencher com a data de hoje
            if (!dataInput.value) {
                dataInput.value = dataHoje;
            }
        }
        
        formBaterPonto.onsubmit = function(e) {
            e.preventDefault();
            const funcionario = funcionarios.find(f => f.id === funcionarioSelecionado);
            if (!funcionario) {
                showModalMessage('Selecione um funcionário primeiro!');
                return;
            }

            const formData = new FormData(this);
            const data = formData.get('data');
            
            // Validar data
            if (!data) {
                showModalMessage('Data é obrigatória!');
                return;
            }
            
            // Validar formato da data (YYYY-MM-DD)
            const dataRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dataRegex.test(data)) {
                showModalMessage('Formato de data inválido! Use o formato YYYY-MM-DD');
                return;
            }
            
            const turno = formData.get('turno');
            const horasExtras = parseFloat(formData.get('horas_extras')) || 0;
            
            // Verificar se já existe um registro para essa data e funcionário
            const registroExistente = registros.find(r => 
                r.funcionario_id === funcionarioSelecionado && 
                r.data === data
            );
            
            if (registroExistente) {
                if (!confirm('Já existe um registro para esta data. Deseja substituí-lo?')) {
                    return;
                }
                // Remover registro existente
                const index = registros.indexOf(registroExistente);
                registros.splice(index, 1);
            }

            // Usar os horários do funcionário baseado no turno selecionado
            const novoRegistro = {
                id: Date.now(),
                funcionario_id: funcionario.id,
                data: data,
                turno_manha_entrada: turno === 'manha' || turno === 'ambos' ? funcionario.horarios?.manha_entrada || '07:00' : '',
                turno_manha_saida: turno === 'manha' || turno === 'ambos' ? funcionario.horarios?.manha_saida || '13:00' : '',
                turno_tarde_entrada: turno === 'tarde' || turno === 'ambos' ? funcionario.horarios?.tarde_entrada || '13:00' : '',
                turno_tarde_saida: turno === 'tarde' || turno === 'ambos' ? funcionario.horarios?.tarde_saida || '19:00' : '',
                horas_extras: horasExtras
            };

            // Calcular horas trabalhadas
            const horasManha = calcularHorasTrabalhadas(novoRegistro.turno_manha_entrada, novoRegistro.turno_manha_saida);
            const horasTarde = calcularHorasTrabalhadas(novoRegistro.turno_tarde_entrada, novoRegistro.turno_tarde_saida);
            novoRegistro.total_horas_trabalhadas = horasManha + horasTarde + horasExtras;

            // Calcular valor diário
            novoRegistro.valor_diario = (novoRegistro.total_horas_trabalhadas * funcionario.valor_hora) +
                (horasExtras * funcionario.valor_hora * (funcionario.multiplicador_extra - 1));

            registros.push(novoRegistro);
            saveDados();
            closeModal();
            filtrarPorMes();
            
            // Resetar formulário e definir data padrão novamente
            this.reset();
            if (dataInput) {
                const hoje = new Date();
                const ano = hoje.getFullYear();
                const mes = String(hoje.getMonth() + 1).padStart(2, '0');
                const dia = String(hoje.getDate()).padStart(2, '0');
                dataInput.value = `${ano}-${mes}-${dia}`;
            }
            
            showModalMessage('Ponto registrado com sucesso!');
        };
    }

    // Adicionar event listener para o checkbox de permitir exclusão
    const allowDeleteCheckbox = document.getElementById('allow-delete-registro');
    if (allowDeleteCheckbox) {
        allowDeleteCheckbox.onchange = function() {
            const btnExcluir = document.getElementById('btn-excluir-registro');
            if (btnExcluir && !adminMode) {
                // Aplicar apenas se não estiver em modo admin
                btnExcluir.style.display = this.checked ? 'block' : 'none';
            }
        };
    }
}

// Modificar a função de editar registro
function openModalEditarRegistro(registro) {
    const funcionario = funcionarios.find(f => f.id === registro.funcionario_id);
    if (!funcionario) return;

    // Permitir edição apenas para admin ou para o próprio funcionário
    if (!adminMode && funcionarioSelecionado !== registro.funcionario_id) {
        showModalMessage('Você não tem permissão para editar este registro');
        return;
    }

    const form = document.getElementById('form-editar-registro');
    
    // Preencher o formulário com os dados atuais
    form.data.value = registro.data;
    form.carga_horaria_dia.value = registro.carga_horaria_dia || funcionario.carga_horaria || 8;
    form.turno_manha_entrada.value = registro.turno_manha_entrada || '';
    form.turno_manha_saida.value = registro.turno_manha_saida || '';
    form.turno_tarde_entrada.value = registro.turno_tarde_entrada || '';
    form.turno_tarde_saida.value = registro.turno_tarde_saida || '';
    form.horas_extras.value = registro.horas_extras || '';

    // Mostrar/ocultar botão de excluir
    const btnExcluir = document.getElementById('btn-excluir-registro');
    const allowDeleteCheckbox = document.getElementById('allow-delete-registro');
    
    if (btnExcluir) {
        if (adminMode) {
            // Sempre mostrar para admin
            btnExcluir.style.display = 'block';
        } else if (funcionarioSelecionado === registro.funcionario_id) {
            // Para funcionário, depende do checkbox
            btnExcluir.style.display = allowDeleteCheckbox.checked ? 'block' : 'none';
        } else {
            btnExcluir.style.display = 'none';
        }
    }

    // Configurar o evento de submit do formulário
    form.onsubmit = function(e) {
        e.preventDefault();
        
        // Atualizar os dados do registro
        registro.data = form.data.value;
        registro.carga_horaria_dia = parseFloat(form.carga_horaria_dia.value) || funcionario.carga_horaria || 8;
        registro.turno_manha_entrada = form.turno_manha_entrada.value;
        registro.turno_manha_saida = form.turno_manha_saida.value;
        registro.turno_tarde_entrada = form.turno_tarde_entrada.value;
        registro.turno_tarde_saida = form.turno_tarde_saida.value;
        registro.horas_extras = parseFloat(form.horas_extras.value) || 0;

        // Calcular horas trabalhadas
        const horasManha = calcularHorasTrabalhadas(registro.turno_manha_entrada, registro.turno_manha_saida);
        const horasTarde = calcularHorasTrabalhadas(registro.turno_tarde_entrada, registro.turno_tarde_saida);
        registro.total_horas_trabalhadas = horasManha + horasTarde + registro.horas_extras;

        // Calcular valor diário
        registro.valor_diario = (registro.total_horas_trabalhadas * funcionario.valor_hora) +
            (registro.horas_extras * funcionario.valor_hora * (funcionario.multiplicador_extra - 1));

        saveDados();
        closeModal();
        filtrarPorMes();
    };

    // Configurar o botão de excluir registro
    if (btnExcluir) {
        btnExcluir.onclick = function() {
            excluirRegistro(registro);
        };
    }

    openModal('editar-registro');
}

// Calcular diferença de horas
function calcularHorasTrabalhadas(entrada, saida) {
  if (!entrada || !saida) return 0;
  const [h1, m1] = entrada.split(':').map(Number);
  const [h2, m2] = saida.split(':').map(Number);
  return (h2 - h1) + (m2 - m1) / 60;
}

// Exportar PDF
function exportarPDF() {
  try {
    const funcionario = funcionarios.find(f => f.id === funcionarioSelecionado);
    if (!funcionario) {
      showModalMessage('Selecione um funcionário primeiro!');
      return;
    }

    const doc = new jspdf.jsPDF();
    const registrosFiltrados = registros.filter(r => r.funcionario_id === funcionarioSelecionado);
    
    // Cabeçalho
    doc.setFontSize(16);
    doc.text('Folha de Ponto', 105, 20, { align: 'center' });
    doc.setFontSize(12);
    doc.text(`Funcionário: ${funcionario.nome}`, 20, 30);
    doc.text(`CPF: ${funcionario.cpf}`, 20, 40);
    
    // Tabela de registros
    let y = 60;
    const headers = ['Data', 'Turno Manhã', 'Turno Tarde', 'Horas Extras', 'Total Horas', 'Valor'];
    
    // Cabeçalho da tabela
    doc.setFillColor(240, 240, 240);
    doc.rect(20, y - 5, 170, 7, 'F');
    headers.forEach((header, index) => {
      doc.text(header, 25 + (index * 28), y);
    });
    
    // Dados da tabela
    y += 10;
    registrosFiltrados.forEach(registro => {
      if (y > 250) {
        doc.addPage();
        y = 20;
      }
      
      doc.text(registro.data, 25, y);
      doc.text(`${registro.turno_manha_entrada}-${registro.turno_manha_saida}`, 53, y);
      doc.text(`${registro.turno_tarde_entrada}-${registro.turno_tarde_saida}`, 81, y);
      doc.text(registro.horas_extras.toString(), 109, y);
      doc.text(registro.total_horas_trabalhadas.toString(), 137, y);
      doc.text(`R$ ${registro.valor_diario.toFixed(2)}`, 165, y);
      
      y += 7;
    });
    
    // Total
    const totalValor = registrosFiltrados.reduce((sum, reg) => sum + reg.valor_diario, 0);
    y += 5;
    doc.setFillColor(240, 240, 240);
    doc.rect(20, y - 5, 170, 7, 'F');
    doc.text(`Total a Receber: R$ ${totalValor.toFixed(2)}`, 150, y, { align: 'right' });
    
    doc.save(`ponto_${funcionario.nome}_${new Date().toISOString().slice(0,10)}.pdf`);
    closeModal();
  } catch (error) {
    console.error('Erro ao gerar PDF:', error);
    showModalMessage('Erro ao gerar PDF. Verifique o console para mais detalhes.');
  }
}

// Definir o mês atual como padrão
function setDefaultMonth() {
  const mesSelecionadoInput = document.getElementById('mes-selecionado');
  if (!mesSelecionadoInput) {
    return;
  }
  
  // Se já houver um valor, não substituir
  if (mesSelecionadoInput.value) {
    filtrarPorMes();
    return;
  }
  
  // Definir mês atual como padrão
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const mesAtual = String(hoje.getMonth() + 1).padStart(2, '0');
  const mesSelecionado = `${anoAtual}-${mesAtual}`;
  mesSelecionadoInput.value = mesSelecionado;
  filtrarPorMes(); // Filtra os registros para o mês atual
}

// Adicionar função para alterar senha
document.getElementById('form-alterar-senha').addEventListener('submit', function(e) {
  e.preventDefault();
  
  const funcionario = funcionarios.find(f => f.id === funcionarioSelecionado);
  const senhaAtual = this.senha_atual.value;
  const novaSenha = this.nova_senha.value;
  const confirmarSenha = this.confirmar_senha.value;
  
  if (senhaAtual !== funcionario.senha) {
    showModalMessage('Senha atual incorreta!');
    return;
  }
  
  if (novaSenha !== confirmarSenha) {
    showModalMessage('As senhas não coincidem!');
    return;
  }
  
  funcionario.senha = novaSenha;
  saveDados();
  closeModal();
  this.reset();
  showModalMessage('Senha alterada com sucesso!');
});

// Nova função para inicializar/reinicializar a página
async function inicializarPagina() {
  // Limpar seleções e estados
  funcionarioSelecionado = null;
  
  // Recarregar dados
  await loadDados();
  
  // Reinicializar event listeners
  configurarEventListeners();
  
  // Resetar formulários
  document.querySelectorAll('form').forEach(form => form.reset());
  
  // Atualizar UI
  updateUI();
  
  // Configurar mês padrão
  setDefaultMonth();
  
  adminMode = String(currentSession?.role || '').toLowerCase() === 'admin';
  const adminIndicator = document.querySelector('.admin-mode');
  if (adminIndicator && !adminMode) {
    adminIndicator.remove();
  }
  aplicarUIAdminDaSessao();
}

// Adicione após a função configurarEventListeners
function aplicarUIAdminDaSessao() {
    const btnAddFuncionario = document.getElementById('btn-add-funcionario');
    const allowDeleteControl = document.querySelector('.allow-delete-control');

    if (btnAddFuncionario) {
        btnAddFuncionario.style.display = adminMode ? 'block' : 'none';
    }

    if (allowDeleteControl) {
        allowDeleteControl.classList.toggle('visible', adminMode);
    }
}

// Modificar a função de abrir modal de exportação
function openModalExportarPDF() {
    if (!funcionarioSelecionado && !adminMode) {
        showModalMessage('Selecione um funcionário primeiro!');
        return;
    }
    openModal('exportar-pdf');
}

// Substituir a função exportarPDF antiga pela nova função gerarPDF
document.getElementById('btn-exportar-pdf').onclick = function() {
    if (adminMode) {
        openModalExportarPDF();
    } else {
        gerarPDF();
    }
};

// Nova função para gerar PDF
function gerarPDF() {
    try {
        const mesAno = document.getElementById('mes-exportar').value || document.getElementById('mes-selecionado').value;
        if (!mesAno) {
            showModalMessage('Selecione um mês/ano');
            return;
        }

        let funcionariosParaExportar = [];
        if (adminMode) {
            const funcSelecionado = document.getElementById('funcionario-exportar').value;
            if (funcSelecionado === 'todos') {
                funcionariosParaExportar = funcionarios;
            } else {
                const func = funcionarios.find(f => f.id === Number(funcSelecionado));
                if (func) funcionariosParaExportar = [func];
            }
        } else {
            const func = funcionarios.find(f => f.id === funcionarioSelecionado);
            if (func) funcionariosParaExportar = [func];
        }

        if (funcionariosParaExportar.length === 0) {
            showModalMessage('Nenhum funcionário selecionado');
            return;
        }

        const [ano, mes] = mesAno.split('-');
        // Criar nova instância do jsPDF
        const doc = new jspdf.jsPDF();

        funcionariosParaExportar.forEach((funcionario, index) => {
            if (index > 0) {
                doc.addPage();
            }

            // Cabeçalho
            doc.setFontSize(16);
            doc.text('Folha de Ponto', doc.internal.pageSize.width / 2, 20, { align: 'center' });
            
            doc.setFontSize(12);
            doc.text(`Funcionário: ${funcionario.nome}`, 20, 35);
            doc.text(`CPF: ${funcionario.cpf}`, 20, 42);
            doc.text(`Mês/Ano: ${mes}/${ano}`, 20, 49);

            // Filtrar registros do funcionário
            const anoInt = parseInt(ano, 10);
            const mesInt = parseInt(mes, 10);
            const registrosFuncionario = registros.filter(r => {
                // Verificar funcionário
                if (r.funcionario_id !== funcionario.id) {
                    return false;
                }
                
                // Comparar diretamente a string da data sem usar new Date() para evitar problemas de fuso horário
                if (!r.data || typeof r.data !== 'string') {
                    return false;
                }
                
                // Extrair ano e mês da string de data (formato: YYYY-MM-DD)
                const partesData = r.data.split('-');
                if (partesData.length !== 3) {
                    return false;
                }
                
                const registroAno = parseInt(partesData[0], 10);
                const registroMes = parseInt(partesData[1], 10);
                
                // Comparar ano e mês diretamente
                return registroAno === anoInt && registroMes === mesInt;
            });

            // Preparar dados para a tabela
            const tableData = registrosFuncionario.map(reg => [
                reg.data,
                `${reg.turno_manha_entrada || '-'}-${reg.turno_manha_saida || '-'}`,
                `${reg.turno_tarde_entrada || '-'}-${reg.turno_tarde_saida || '-'}`,
                reg.horas_extras || '0',
                reg.total_horas_trabalhadas || '0',
                `R$ ${(reg.valor_diario || 0).toFixed(2)}`
            ]);

            // Configuração da tabela
            doc.autoTable({
                startY: 55,
                head: [['Data', 'Turno Manhã', 'Turno Tarde', 'H. Extras', 'Total Horas', 'Valor']],
                body: tableData,
                theme: 'grid',
                styles: {
                    fontSize: 8,
                    cellPadding: 2,
                },
                headStyles: {
                    fillColor: [66, 66, 66],
                    textColor: 255,
                    fontSize: 8,
                    fontStyle: 'bold',
                },
                columnStyles: {
                    0: { cellWidth: 25 }, // Data
                    1: { cellWidth: 35 }, // Turno Manhã
                    2: { cellWidth: 35 }, // Turno Tarde
                    3: { cellWidth: 20 }, // H. Extras
                    4: { cellWidth: 25 }, // Total Horas
                    5: { cellWidth: 30 }  // Valor
                }
            });

            // Calcular e adicionar total
            const totalValor = registrosFuncionario.reduce((sum, reg) => sum + (reg.valor_diario || 0), 0);
            const finalY = doc.previousAutoTable.finalY || 150;
            doc.text(`Total a Receber: R$ ${totalValor.toFixed(2)}`, 170, finalY + 10, { align: 'right' });
        });

        // Salvar o PDF
        doc.save(`ponto_${mesAno}.pdf`);
        closeModal();
        showModalMessage('PDF gerado com sucesso!');
    } catch (error) {
        console.error('Erro ao gerar PDF:', error);
        showModalMessage(`Erro ao gerar PDF: ${error.message}`);
    }
}

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

// Garantir que a função seja chamada quando a página carregar
document.addEventListener('DOMContentLoaded', async () => {
    currentSession = await garantirAcesso(['admin', 'recepcao', 'tecnico']);
    // Carregar tema novamente para garantir
    loadTheme();
    
    await inicializarPagina();
    configurarEventListeners();
    
    // Adicionar listener para o campo de mês para garantir que o filtro seja aplicado
    const mesSelecionadoInput = document.getElementById('mes-selecionado');
    if (mesSelecionadoInput) {
        // Adicionar listener adicional caso o onchange não funcione
        mesSelecionadoInput.addEventListener('change', () => {
            filtrarPorMes();
        });
        
        // Adicionar listener para eventos de input (quando o usuário digita)
        mesSelecionadoInput.addEventListener('input', () => {
            // Aplicar filtro quando o usuário terminar de digitar
            setTimeout(() => {
                filtrarPorMes();
            }, 300);
        });
    }
});

// Verificar e substituir outros alerts no código
function validarRegistro(registro) {
    if (!registro.data) {
        showModalMessage('Data é obrigatória');
        return false;
    }
    if (!registro.turno_manha_entrada && !registro.turno_tarde_entrada) {
        showModalMessage('Pelo menos um turno deve ser preenchido');
        return false;
    }
    return true;
}

// Função de logout do funcionário
function logoutFuncionario() {
    funcionarioSelecionado = null;
    document.getElementById('titulo-registro-ponto').textContent = 'Registros de Ponto';
    document.getElementById('btn-bater-ponto').style.display = 'none';
    
    const btnAlterarSenha = document.getElementById('btn-alterar-senha');
    if (btnAlterarSenha) {
        btnAlterarSenha.remove();
    }
    
    closeModal();
    updateUI(); // Atualizar UI para remover o destaque
    filtrarPorMes();
}


// Modificar a função de excluir registro
function excluirRegistro(registro) {
    if (!adminMode) {
        showModalMessage('Apenas administradores podem excluir registros');
        return;
    }
    
    // Criar um modal de confirmação personalizado
    const modalHtml = `
        <div id="modal-confirmar-exclusao" class="modal">
            <h3>Confirmar Exclusão</h3>
            <p>Tem certeza que deseja excluir este registro?</p>
            <button onclick="confirmarExclusao(${registro.id})">Sim</button>
            <button onclick="closeModal()">Não</button>
        </div>
    `;

    // Adicionar o modal ao documento se ainda não existir
    if (!document.getElementById('modal-confirmar-exclusao')) {
        document.body.insertAdjacentHTML('beforeend', modalHtml);
    }

    openModal('confirmar-exclusao');
}

// Função para confirmar a exclusão
function confirmarExclusao(registroId) {
    registros = registros.filter(r => r.id !== registroId);
    saveDados();
    closeModal();
    filtrarPorMes();
}
