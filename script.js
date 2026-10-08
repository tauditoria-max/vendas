// ============================================================
// AUDITORIA SHOPPING - SCRIPT PRINCIPAL
// Compatível com Android 6.0.1 Marshmallow
// Suporte a login offline + fila de sincronização
// ============================================================

// --- CONFIGURAÇÕES GLOBAIS ---
const DOMINIO_FICTICIO = "@tacaruna.com.br";
const USUARIO_ADMIN = "diegofilipe";

// --- LISTA DE LOJAS FIXA NO CÓDIGO ---
const LOJAS = [
    "Aby's",
    "Hering Kids",
    "Nel Blu",
    "Ecológica",
    "Grandão do Queijo",
    "Mundo Verde"
];

// --- ESTADO GLOBAL ---
let usuarioLogado = null;
let lojaSelecionada = null;
let fluxoDocIdHoje = null;
let exportacaoOrigem = 'lojas';

// ============================================================
// SISTEMA DE LOGIN OFFLINE (cache de credenciais)
// ============================================================
const CRED_KEY = 'auditoria_credenciais';
const SESSAO_KEY = 'auditoria_sessao_offline';

async function hashSenha(texto) {
    if (window.crypto && window.crypto.subtle) {
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(texto);
            const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            console.warn("crypto.subtle falhou, usando fallback:", e);
        }
    }
    let hash = 0;
    for (let i = 0; i < texto.length; i++) {
        hash = ((hash << 5) - hash) + texto.charCodeAt(i);
        hash = hash & hash;
    }
    return 'fb_' + Math.abs(hash).toString(16);
}

function lerCredenciais() {
    try {
        const txt = localStorage.getItem(CRED_KEY);
        return txt ? JSON.parse(txt) : {};
    } catch (e) {
        return {};
    }
}

async function salvarCredencial(usuario, senha) {
    try {
        const creds = lerCredenciais();
        const hash = await hashSenha(senha);
        creds[usuario.toLowerCase()] = {
            hash: hash,
            ultimoLogin: new Date().toISOString()
        };
        localStorage.setItem(CRED_KEY, JSON.stringify(creds));
    } catch (e) {
        console.error("Erro ao salvar credencial:", e);
    }
}

async function validarCredencialOffline(usuario, senha) {
    const creds = lerCredenciais();
    const u = usuario.toLowerCase();
    if (!creds[u]) return false;
    const hash = await hashSenha(senha);
    return creds[u].hash === hash;
}

function salvarSessaoOffline(usuario) {
    try {
        localStorage.setItem(SESSAO_KEY, JSON.stringify({
            usuario: usuario,
            data: new Date().toISOString()
        }));
    } catch (e) {}
}

function lerSessaoOffline() {
    try {
        const txt = localStorage.getItem(SESSAO_KEY);
        return txt ? JSON.parse(txt) : null;
    } catch (e) {
        return null;
    }
}

function removerSessaoOffline() {
    try {
        localStorage.removeItem(SESSAO_KEY);
    } catch (e) {}
}

function temCredenciaisSalvas() {
    const creds = lerCredenciais();
    return Object.keys(creds).length > 0;
}

function ehErroDeRede(error) {
    if (!error) return false;
    const code = error.code || '';
    return code === 'auth/network-request-failed' ||
           code === 'auth/internal-error' ||
           !estaOnline();
}

// ============================================================
// SISTEMA DE FILA OFFLINE
// ============================================================
const FILA_KEY = 'auditoria_fila_sync';

function lerFila() {
    try {
        const txt = localStorage.getItem(FILA_KEY);
        return txt ? JSON.parse(txt) : [];
    } catch (e) {
        console.error("Erro ao ler fila:", e);
        return [];
    }
}

function salvarFila(fila) {
    try {
        localStorage.setItem(FILA_KEY, JSON.stringify(fila));
        atualizarIndicadorFila();
    } catch (e) {
        console.error("Erro ao salvar fila:", e);
    }
}

function adicionarNaFila(item) {
    const fila = lerFila();
    item._localId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    item._dataLocal = new Date().toISOString();
    fila.push(item);
    salvarFila(fila);
    return item._localId;
}

function removerDaFila(localId) {
    let fila = lerFila();
    fila = fila.filter(i => i._localId !== localId);
    salvarFila(fila);
}

function atualizarIndicadorFila() {
    const fila = lerFila();
    const qtd = fila.length;
    const indicador = document.getElementById('indicador-fila');
    if (!indicador) return;

    if (qtd === 0) {
        indicador.style.display = 'none';
    } else {
        indicador.style.display = 'inline-block';
        indicador.textContent = qtd;
        indicador.title = qtd + ' item(ns) aguardando sincronização';
    }
}

function estaOnline() {
    return navigator.onLine !== false;
}

async function sincronizarFila() {
    if (!estaOnline()) {
        console.log("Offline: sincronização adiada.");
        return;
    }

    // Se não tem usuário Firebase mas tem sessão offline, pede a senha para reautenticar
    if (!auth.currentUser && lerSessaoOffline()) {
        const sessao = lerSessaoOffline();
        const senha = prompt("Digite sua senha para sincronizar (" + sessao.usuario + "):");
        if (!senha) return;

        try {
            const emailFake = sessao.usuario + DOMINIO_FICTICIO;
            await auth.signInWithEmailAndPassword(emailFake, senha);
            usuarioLogado = sessao.usuario;
            await salvarCredencial(sessao.usuario, senha);
            console.log("Reautenticado com sucesso.");
        } catch (err) {
            console.error("Falha ao reautenticar:", err);
            alert("Não foi possível reautenticar. Verifique a senha.");
            return;
        }
    }

    if (!auth.currentUser) {
        console.log("Usuário não logado: sincronização adiada.");
        return;
    }

    const fila = lerFila();
    if (fila.length === 0) {
        atualizarStatusConexao();
        return;
    }

    console.log("Sincronizando " + fila.length + " item(ns)...");

    for (let i = 0; i < fila.length; i++) {
        const item = fila[i];
        try {
            const dados = Object.assign({}, item);
            delete dados._localId;
            delete dados._dataLocal;

            if (dados.dataHoraLocal) {
                dados.dataHora = firebase.firestore.Timestamp.fromDate(new Date(dados.dataHoraLocal));
                delete dados.dataHoraLocal;
            } else if (!dados.dataHora) {
                dados.dataHora = firebase.firestore.FieldValue.serverTimestamp();
            }

            if (dados._docId) {
                const docId = dados._docId;
                delete dados._docId;
                await db.collection('registros').doc(docId).set(dados, { merge: true });
            } else {
                await db.collection('registros').add(dados);
            }

            removerDaFila(item._localId);
            console.log("✓ Sincronizado: " + item.tipo);

        } catch (err) {
            console.error("✗ Erro ao sincronizar item:", err);
        }
    }

    atualizarStatusConexao();
}

async function salvarComFila(dados, docId) {
    const itemParaFila = Object.assign({}, dados);
    itemParaFila.dataHoraLocal = new Date().toISOString();
    if (docId) itemParaFila._docId = docId;

    if (estaOnline() && auth.currentUser) {
        try {
            const dadosEnvio = Object.assign({}, dados);
            dadosEnvio.dataHora = firebase.firestore.FieldValue.serverTimestamp();

            if (docId) {
                await db.collection('registros').doc(docId).set(dadosEnvio, { merge: true });
            } else {
                await db.collection('registros').add(dadosEnvio);
            }
            return { ok: true, offline: false };
        } catch (err) {
            console.warn("Falha ao enviar, adicionando à fila:", err);
            adicionarNaFila(itemParaFila);
            return { ok: true, offline: true };
        }
    } else {
        adicionarNaFila(itemParaFila);
        return { ok: true, offline: true };
    }
}

window.addEventListener('online', () => {
    console.log("Voltou a conexão. Sincronizando...");
    atualizarStatusConexao();
    setTimeout(sincronizarFila, 500);
});

window.addEventListener('offline', () => {
    console.log("Perdeu a conexão.");
    atualizarStatusConexao();
});

function atualizarStatusConexao() {
    const el = document.getElementById('status-conexao');
    const elOff = document.getElementById('sessao-offline-aviso');

    if (el) el.style.display = estaOnline() ? 'none' : 'block';

    if (elOff) {
        const semAuth = !auth.currentUser && lerSessaoOffline();
        elOff.style.display = (semAuth && estaOnline()) ? 'block' : 'none';
    }
}

// ============================================================
// NAVEGAÇÃO ENTRE TELAS
// ============================================================
function mostrarTela(idTela) {
    document.querySelectorAll('.tela').forEach(t => t.classList.remove('ativa'));
    document.getElementById(idTela).classList.add('ativa');
}

function ehAdmin() {
    return usuarioLogado && usuarioLogado.toLowerCase() === USUARIO_ADMIN.toLowerCase();
}

// ============================================================
// REGISTRAR LOGIN NO FIREBASE
// ============================================================
async function registrarLogin(usuario) {
    if (!estaOnline() || !auth.currentUser) return;
    try {
        await db.collection('logins').add({
            usuario: usuario,
            dataHora: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.error("Erro ao registrar login:", error);
    }
}

// ============================================================
// LOGIN (com suporte offline)
// ============================================================
async function fazerLogin() {
    const usuario = document.getElementById('login-usuario').value.trim().toLowerCase();
    const senha = document.getElementById('login-senha').value.trim();
    const erroEl = document.getElementById('login-erro');
    const btnEntrar = document.querySelector('#tela-login .btn-primario');

    if (!usuario || !senha) {
        erroEl.textContent = "Preencha usuário e senha.";
        return;
    }

    btnEntrar.textContent = "Entrando...";
    btnEntrar.disabled = true;
    erroEl.textContent = "";

    // ---- CASO 1: SEM INTERNET ----
    if (!estaOnline()) {
        const valido = await validarCredencialOffline(usuario, senha);
        if (valido) {
            usuarioLogado = usuario;
            salvarSessaoOffline(usuario);
            carregarLojas();
            mostrarTela('tela-lojas');
            document.getElementById('login-usuario').value = "";
            document.getElementById('login-senha').value = "";
            atualizarStatusConexao();
            atualizarIndicadorFila();
            btnEntrar.textContent = "Entrar";
            btnEntrar.disabled = false;
            return;
        } else {
            if (temCredenciaisSalvas()) {
                erroEl.textContent = "Sem internet. Usuário ou senha não conferem com o último login.";
            } else {
                erroEl.textContent = "Sem internet. É necessário fazer o primeiro login online.";
            }
            btnEntrar.textContent = "Entrar";
            btnEntrar.disabled = false;
            return;
        }
    }

    // ---- CASO 2: COM INTERNET - Tenta Firebase ----
    const emailFake = usuario + DOMINIO_FICTICIO;

    try {
        const cred = await auth.signInWithEmailAndPassword(emailFake, senha);
        usuarioLogado = cred.user.email.split('@')[0];

        await salvarCredencial(usuario, senha);
        salvarSessaoOffline(usuarioLogado);

        registrarLogin(usuarioLogado);
        carregarLojas();
        mostrarTela('tela-lojas');
        document.getElementById('login-usuario').value = "";
        document.getElementById('login-senha').value = "";

        setTimeout(sincronizarFila, 1500);

    } catch (error) {
        console.error("Erro no login:", error);

        if (ehErroDeRede(error)) {
            const valido = await validarCredencialOffline(usuario, senha);
            if (valido) {
                usuarioLogado = usuario;
                salvarSessaoOffline(usuario);
                carregarLojas();
                mostrarTela('tela-lojas');
                document.getElementById('login-usuario').value = "";
                document.getElementById('login-senha').value = "";
                atualizarStatusConexao();
                atualizarIndicadorFila();
                btnEntrar.textContent = "Entrar";
                btnEntrar.disabled = false;
                return;
            }
            erroEl.textContent = "Falha de conexão. Verifique a internet.";
        } else if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password') {
            erroEl.textContent = "Usuário ou senha incorretos.";
        } else if (error.code === 'auth/too-many-requests') {
            erroEl.textContent = "Muitas tentativas. Aguarde.";
        } else {
            erroEl.textContent = "Erro ao entrar. Tente novamente.";
        }
    } finally {
        btnEntrar.textContent = "Entrar";
        btnEntrar.disabled = false;
    }
}

function fazerLogout() {
    removerSessaoOffline();

    if (estaOnline() && auth.currentUser) {
        auth.signOut().catch(err => console.warn("Erro ao sair do Firebase:", err));
    }

    usuarioLogado = null;
    lojaSelecionada = null;
    fluxoDocIdHoje = null;
    mostrarTela('tela-login');
}

// ============================================================
// SELEÇÃO DE LOJA
// ============================================================
function carregarLojas() {
    const container = document.getElementById('lista-lojas');
    container.innerHTML = "";
    LOJAS.forEach(loja => {
        const div = document.createElement('div');
        div.className = 'card-loja';
        div.textContent = loja;
        div.onclick = () => selecionarLoja(loja);
        container.appendChild(div);
    });

    const btnExportar = document.getElementById('btn-exportar');
    if (btnExportar) {
        btnExportar.style.display = ehAdmin() ? 'inline-block' : 'none';
    }

    atualizarIndicadorFila();
    atualizarStatusConexao();
    atualizarPainelAdmin(); // <-- NOVA LINHA
}

function selecionarLoja(loja) {
    lojaSelecionada = loja;
    document.getElementById('nome-loja-header').textContent = loja;
    document.getElementById('nome-auditor-header').textContent = `Auditor: ${usuarioLogado}`;
    mostrarTela('tela-principal');
    mudarAba('vendas');
    fluxoDocIdHoje = null;
    carregarFluxoHoje();
    atualizarIndicadorFila();
    atualizarStatusConexao();
}

function voltarParaLojas() {
    lojaSelecionada = null;
    mostrarTela('tela-lojas');
    atualizarIndicadorFila();
    atualizarStatusConexao();
}

// ============================================================
// NAVEGAÇÃO DE ABAS
// ============================================================
function mudarAba(aba) {
    document.querySelectorAll('.aba').forEach(b => b.classList.remove('ativa'));
    document.getElementById(`aba-${aba}`).classList.add('ativa');
    document.querySelectorAll('.conteudo-aba').forEach(c => c.classList.remove('ativa'));
    document.getElementById(`conteudo-${aba}`).classList.add('ativa');
}

// ============================================================
// SALVAR VENDA
// ============================================================
async function salvarVenda() {
    const valor = document.getElementById('venda-valor').value;
    const sexo = document.getElementById('venda-sexo').value;
    const pagamento = document.getElementById('venda-pagamento').value;
    const obs = document.getElementById('venda-obs').value;
    const troca = document.getElementById('venda-troca').checked;
    const virada = document.getElementById('venda-virada').checked;

    if (!valor || !sexo || !pagamento) {
        alert("Preencha os campos obrigatórios: Valor, Sexo e Forma de Pagamento.");
        return;
    }

    const dados = {
        tipo: 'venda',
        loja: lojaSelecionada,
        auditor: usuarioLogado,
        valor: parseFloat(valor),
        sexo: sexo,
        pagamento: pagamento,
        observacao: obs,
        troca: troca,
        virada: virada
    };

    const resultado = await salvarComFila(dados);

    if (resultado.offline) {
        alert("Venda Registrada.");
    } else {
        alert("Venda gravada com sucesso!");
    }

    limparFormularioVenda();
}

function limparFormularioVenda() {
    document.getElementById('venda-valor').value = "";
    document.getElementById('venda-sexo').value = "";
    document.getElementById('venda-pagamento').value = "";
    document.getElementById('venda-obs').value = "";
    document.getElementById('venda-troca').checked = false;
    document.getElementById('venda-virada').checked = false;
}

// ============================================================
// FLUXO - SALVAMENTO AUTOMÁTICO COM FILA
// ============================================================
function getDataHoje() {
    const d = new Date();
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
}

async function alterarFluxo(id, valor) {
    const input = document.getElementById(`fluxo-${id}`);
    let atual = parseInt(input.value) || 0;
    atual += valor;
    if (atual < 0) atual = 0;
    input.value = atual;
    await salvarFluxoAuto();
}

async function salvarFluxoAuto() {
    if (!lojaSelecionada || !usuarioLogado) return;

    const statusEl = document.getElementById('fluxo-status');
    statusEl.textContent = "Salvando...";
    statusEl.className = "fluxo-status salvando";

    const dados = {
        tipo: 'fluxo',
        loja: lojaSelecionada,
        auditor: usuarioLogado,
        data: getDataHoje(),
        especulador_m: parseInt(document.getElementById('fluxo-esp-m').value) || 0,
        especulador_f: parseInt(document.getElementById('fluxo-esp-f').value) || 0,
        acompanhante_m: parseInt(document.getElementById('fluxo-acomp-m').value) || 0,
        acompanhante_f: parseInt(document.getElementById('fluxo-acomp-f').value) || 0,
        outros_m: parseInt(document.getElementById('fluxo-out-m').value) || 0,
        outros_f: parseInt(document.getElementById('fluxo-out-f').value) || 0
    };

    const idDoc = `fluxo_${lojaSelecionada.replace(/\s+/g, '-')}_${usuarioLogado}_${getDataHoje()}`;
    const resultado = await salvarComFila(dados, idDoc);

    if (resultado.offline) {
        statusEl.textContent = "Salvo localmente (offline) ✓";
        statusEl.className = "fluxo-status salvando";
    } else {
        statusEl.textContent = "Salvo automaticamente ✓";
        statusEl.className = "fluxo-status";
    }

    setTimeout(() => {
        if (estaOnline() && statusEl.textContent === "Salvo automaticamente ✓") {
            statusEl.textContent = "Todos os toques são salvos automaticamente ✓";
            statusEl.className = "fluxo-status";
        }
    }, 1500);
}

async function carregarFluxoHoje() {
    if (!lojaSelecionada || !usuarioLogado) return;

    const idDoc = `fluxo_${lojaSelecionada.replace(/\s+/g, '-')}_${usuarioLogado}_${getDataHoje()}`;

    if (!estaOnline() || !auth.currentUser) {
        const fila = lerFila();
        const itemFluxo = fila.find(i => i._docId === idDoc);
        if (itemFluxo) {
            document.getElementById('fluxo-esp-m').value = itemFluxo.especulador_m || 0;
            document.getElementById('fluxo-esp-f').value = itemFluxo.especulador_f || 0;
            document.getElementById('fluxo-acomp-m').value = itemFluxo.acompanhante_m || 0;
            document.getElementById('fluxo-acomp-f').value = itemFluxo.acompanhante_f || 0;
            document.getElementById('fluxo-out-m').value = itemFluxo.outros_m || 0;
            document.getElementById('fluxo-out-f').value = itemFluxo.outros_f || 0;

            const statusEl = document.getElementById('fluxo-status');
            statusEl.textContent = "Fluxo de hoje (offline) carregado ✓";
            statusEl.className = "fluxo-status salvando";
        }
        return;
    }

    try {
        const docSnap = await db.collection('registros').doc(idDoc).get();
        if (docSnap.exists) {
            const data = docSnap.data();
            fluxoDocIdHoje = idDoc;
            document.getElementById('fluxo-esp-m').value = data.especulador_m || 0;
            document.getElementById('fluxo-esp-f').value = data.especulador_f || 0;
            document.getElementById('fluxo-acomp-m').value = data.acompanhante_m || 0;
            document.getElementById('fluxo-acomp-f').value = data.acompanhante_f || 0;
            document.getElementById('fluxo-out-m').value = data.outros_m || 0;
            document.getElementById('fluxo-out-f').value = data.outros_f || 0;

            const statusEl = document.getElementById('fluxo-status');
            statusEl.textContent = "Fluxo de hoje carregado ✓";
            statusEl.className = "fluxo-status";
        } else {
            const fila = lerFila();
            const itemFluxo = fila.find(i => i._docId === idDoc);
            if (itemFluxo) {
                document.getElementById('fluxo-esp-m').value = itemFluxo.especulador_m || 0;
                document.getElementById('fluxo-esp-f').value = itemFluxo.especulador_f || 0;
                document.getElementById('fluxo-acomp-m').value = itemFluxo.acompanhante_m || 0;
                document.getElementById('fluxo-acomp-f').value = itemFluxo.acompanhante_f || 0;
                document.getElementById('fluxo-out-m').value = itemFluxo.outros_m || 0;
                document.getElementById('fluxo-out-f').value = itemFluxo.outros_f || 0;
            } else {
                fluxoDocIdHoje = null;
                ['esp-m', 'esp-f', 'acomp-m', 'acomp-f', 'out-m', 'out-f'].forEach(id => {
                    document.getElementById(`fluxo-${id}`).value = 0;
                });
            }
        }
    } catch (error) {
        console.error("Erro ao carregar fluxo:", error);
    }
}

// ============================================================
// SALVAR PERDA
// ============================================================
async function salvarPerda() {
    const motivo = document.getElementById('perda-motivo').value;
    const obs = document.getElementById('perda-obs').value;

    if (!motivo) {
        alert("Selecione o motivo da perda.");
        return;
    }

    const dados = {
        tipo: 'perda',
        loja: lojaSelecionada,
        auditor: usuarioLogado,
        motivo: motivo,
        observacao: obs
    };

    const resultado = await salvarComFila(dados);

    if (resultado.offline) {
        alert("Perda Registrada.");
    } else {
        alert("Perda gravada com sucesso!");
    }

    document.getElementById('perda-motivo').value = "";
    document.getElementById('perda-obs').value = "";
}

// ============================================================
// ÚLTIMAS DO DIA (próprio auditor, inclui fila offline)
// ============================================================
async function verUltimas(tipo) {
    const modal = document.getElementById('modal-ultimos');
    const lista = document.getElementById('lista-ultimos');
    lista.innerHTML = "<p>Carregando...</p>";
    modal.classList.add('ativa');

    const tipoBanco = tipo === 'vendas' ? 'venda' : (tipo === 'perdas' ? 'perda' : tipo);
    window.tipoAtualModal = tipoBanco;

    const agora = new Date();
    const inicioDia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 0, 0, 0);
    const fimDia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 23, 59, 59);

    try {
        let todos = [];

        if (estaOnline() && auth.currentUser) {
            try {
                const snapshot = await db.collection('registros')
                    .where('loja', '==', lojaSelecionada)
                    .where('auditor', '==', usuarioLogado)
                    .get();

                snapshot.forEach(doc => {
                    const data = doc.data();
                    data._id = doc.id;
                    data._origem = 'firebase';
                    if (data.dataHora) {
                        const ts = data.dataHora.toMillis();
                        if (ts < inicioDia.getTime() || ts > fimDia.getTime()) return;
                    } else {
                        return;
                    }
                    todos.push(data);
                });
            } catch (err) {
                console.warn("Erro ao buscar do Firebase, usando só fila:", err);
            }
        }

        const fila = lerFila();
        fila.forEach(item => {
            if (item.loja !== lojaSelecionada) return;
            if (item.auditor !== usuarioLogado) return;
            if (item.tipo !== tipoBanco) return;

            if (item.dataHoraLocal) {
                const d = new Date(item.dataHoraLocal);
                if (d < inicioDia || d > fimDia) return;
                item._id = item._localId;
                item._origem = 'fila';
                item._timestampMs = d.getTime();
                todos.push(item);
            }
        });

        if (todos.length === 0) {
            lista.innerHTML = "<p>Você ainda não tem registros deste tipo hoje.</p>";
            return;
        }

        todos.sort((a, b) => {
            const ta = a._timestampMs ? a._timestampMs : (a.dataHora ? a.dataHora.toMillis() : 0);
            const tb = b._timestampMs ? b._timestampMs : (b.dataHora ? b.dataHora.toMillis() : 0);
            return tb - ta;
        });

        const dataHojeStr = String(agora.getDate()).padStart(2, '0') + '/' +
                            String(agora.getMonth() + 1).padStart(2, '0') + '/' +
                            agora.getFullYear();

        lista.innerHTML = "";
        const cabecalho = document.createElement('div');
        cabecalho.style.cssText = "background:#1f4e78; color:#fff; padding:8px 12px; border-radius:6px; margin-bottom:12px; font-size:0.85rem; text-align:center;";
        cabecalho.innerHTML = `<strong>${dataHojeStr}</strong> — ${todos.length} registro(s) hoje`;
        lista.appendChild(cabecalho);

        todos.forEach(data => {
            const item = document.createElement('div');
            item.className = 'item-registro';

            const info = document.createElement('div');
            info.className = 'item-info';

            let horaStr = "—";
            if (data.dataHora) {
                const d = data.dataHora.toDate();
                horaStr = String(d.getHours()).padStart(2, '0') + ':' +
                          String(d.getMinutes()).padStart(2, '0');
            } else if (data.dataHoraLocal) {
                const d = new Date(data.dataHoraLocal);
                horaStr = String(d.getHours()).padStart(2, '0') + ':' +
                          String(d.getMinutes()).padStart(2, '0');
            }

            const pendenteIcon = data._origem === 'fila' ? ' <span style="color:#d9534f;">●</span>' : '';

            if (tipoBanco === 'venda') {
                const v = typeof data.valor === 'number' ? data.valor.toFixed(2) : data.valor;
                info.innerHTML = `<strong>${horaStr}</strong>${pendenteIcon} — R$ ${v}<br>${data.pagamento}${data.sexo ? ' · ' + data.sexo : ''}`;
            } else if (tipoBanco === 'perda') {
                info.innerHTML = `<strong>${horaStr}</strong>${pendenteIcon} — ${data.motivo}${data.observacao ? '<br>' + data.observacao : ''}`;
            } else if (tipoBanco === 'fluxo') {
                info.innerHTML = `<strong>${horaStr}</strong>${pendenteIcon}<br>Esp: ${data.especulador_m}M / ${data.especulador_f}F<br>Acomp: ${data.acompanhante_m}M / ${data.acompanhante_f}F`;
            }

            const acoes = document.createElement('div');
            acoes.className = 'item-acoes';

            if (data._origem === 'firebase') {
                const btnEditar = document.createElement('button');
                btnEditar.textContent = "✏️";
                btnEditar.className = 'btn-item btn-editar';
                btnEditar.onclick = () => editarRegistro(data._id, tipoBanco);

                const btnExcluir = document.createElement('button');
                btnExcluir.textContent = "🗑️";
                btnExcluir.className = 'btn-item btn-excluir';
                btnExcluir.onclick = () => excluirRegistro(data._id, tipoBanco);

                acoes.appendChild(btnEditar);
                acoes.appendChild(btnExcluir);
            } else {
                const aviso = document.createElement('div');
                aviso.style.cssText = "font-size:0.7rem; color:#d9534f; text-align:center; padding:6px;";
                aviso.textContent = "Pendente";
                acoes.appendChild(aviso);
            }

            item.appendChild(info);
            item.appendChild(acoes);
            lista.appendChild(item);
        });

        if (tipoBanco === 'venda') {
            let totalDia = 0;
            todos.forEach(v => { totalDia += parseFloat(v.valor) || 0; });
            const rodape = document.createElement('div');
            rodape.style.cssText = "background:#2f75b5; color:#fff; padding:10px; border-radius:6px; margin-top:12px; text-align:center; font-weight:bold;";
            rodape.innerHTML = `Total do dia: R$ ${totalDia.toFixed(2).replace('.', ',')}`;
            lista.appendChild(rodape);
        }

    } catch (error) {
        console.error("Erro ao buscar últimas:", error);
        lista.innerHTML = `<p style="color:#d9534f;">Erro: ${error.message}</p>`;
    }
}

function fecharModal() {
    document.getElementById('modal-ultimos').classList.remove('ativa');
}

// ============================================================
// EXCLUIR REGISTRO
// ============================================================
async function excluirRegistro(id, tipo) {
    if (!confirm("Tem certeza que deseja EXCLUIR este registro?")) return;

    try {
        await db.collection('registros').doc(id).delete();
        alert("Registro excluído!");
        verUltimas(tipo === 'venda' ? 'vendas' : (tipo === 'perda' ? 'perdas' : tipo));
    } catch (error) {
        console.error("Erro ao excluir:", error);
        alert("Erro ao excluir: " + error.message);
    }
}

// ============================================================
// EDITAR REGISTRO
// ============================================================
async function editarRegistro(id, tipo) {
    try {
        const docRef = db.collection('registros').doc(id);
        const docSnap = await docRef.get();
        if (!docSnap.exists) {
            alert("Registro não encontrado.");
            return;
        }

        const data = docSnap.data();

        if (tipo === 'venda') {
            const novoValor = prompt("Novo valor (R$):", data.valor);
            if (novoValor === null) return;
            const novasObs = prompt("Nova observação:", data.observacao || "");
            if (novasObs === null) return;
            const novoTroca = confirm("Marcar como TROCA? (OK = Sim, Cancelar = Não)");
            const novaVirada = confirm("Marcar como VIRADA? (OK = Sim, Cancelar = Não)");

            await docRef.update({
                valor: parseFloat(novoValor),
                observacao: novasObs,
                troca: novoTroca,
                virada: novaVirada
            });
        } else if (tipo === 'perda') {
            const novaObs = prompt("Nova observação:", data.observacao || "");
            if (novaObs === null) return;
            await docRef.update({ observacao: novaObs });
        } else if (tipo === 'fluxo') {
            const novoEspM = prompt("Especulador Masculino:", data.especulador_m);
            if (novoEspM === null) return;
            const novoEspF = prompt("Especulador Feminino:", data.especulador_f);
            if (novoEspF === null) return;
            await docRef.update({
                especulador_m: parseInt(novoEspM) || 0,
                especulador_f: parseInt(novoEspF) || 0
            });
        }

        alert("Registro atualizado!");
        verUltimas(tipo === 'venda' ? 'vendas' : (tipo === 'perda' ? 'perdas' : tipo));

    } catch (error) {
        console.error("Erro ao editar:", error);
        alert("Erro ao editar: " + error.message);
    }
}

// ============================================================
// EXPORTAÇÃO - ABRIR TELA (somente admin)
// ============================================================
async function abrirExportacao(origem) {
    if (!ehAdmin()) {
        alert("Apenas o administrador pode exportar dados.");
        return;
    }

    exportacaoOrigem = origem || 'lojas';
    mostrarTela('tela-exportar');

    const selectLoja = document.getElementById('export-loja');
    selectLoja.innerHTML = '<option value="">Todas as lojas</option>';
    LOJAS.forEach(loja => {
        const opt = document.createElement('option');
        opt.value = loja;
        opt.textContent = loja;
        selectLoja.appendChild(opt);
    });

    const hoje = new Date();
    const primeiroDia = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    document.getElementById('export-data-inicio').value = formatarDataInput(primeiroDia);
    document.getElementById('export-data-fim').value = formatarDataInput(hoje);

    const selectAuditor = document.getElementById('export-auditor');
    selectAuditor.disabled = true;
    selectAuditor.innerHTML = '<option value="">Carregando...</option>';

    try {
        const snapshot = await db.collection('registros').get();
        const setAuditores = {};
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.auditor) setAuditores[data.auditor] = true;
        });

        const auditores = Object.keys(setAuditores).sort();
        selectAuditor.innerHTML = '<option value="">Todos os auditores</option>';
        auditores.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a;
            opt.textContent = a;
            selectAuditor.appendChild(opt);
        });

        if (auditores.length === 0) {
            selectAuditor.innerHTML = '<option value="">Nenhum auditor com registro</option>';
        }
    } catch (error) {
        console.error("Erro ao carregar auditores:", error);
        selectAuditor.innerHTML = '<option value="">Erro ao carregar</option>';
    }

    selectAuditor.disabled = false;

    document.getElementById('export-status').textContent = "Selecione o período e clique em Gerar.";
    document.getElementById('export-status').className = "fluxo-status";
}

function formatarDataInput(d) {
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
}

function fecharExportacao() {
    if (exportacaoOrigem === 'login') {
        auth.signOut().then(() => {
            usuarioLogado = null;
            lojaSelecionada = null;
            mostrarTela('tela-login');
        });
    } else {
        mostrarTela('tela-lojas');
    }
}

// ============================================================
// EXPORTAÇÃO - GERAR CSV (inclui fila local)
// ============================================================
async function exportarDados() {
    if (!ehAdmin()) {
        alert("Apenas o administrador pode exportar dados.");
        return;
    }

    const loja = document.getElementById('export-loja').value;
    let auditor = document.getElementById('export-auditor').value.trim().toLowerCase();
    const dataInicioStr = document.getElementById('export-data-inicio').value;
    const dataFimStr = document.getElementById('export-data-fim').value;
    const incluirVendas = document.getElementById('export-incluir-vendas').checked;
    const incluirFluxo = document.getElementById('export-incluir-fluxo').checked;
    const incluirPerdas = document.getElementById('export-incluir-perdas').checked;

    if (!incluirVendas && !incluirFluxo && !incluirPerdas) {
        alert("Selecione pelo menos um tipo de dado.");
        return;
    }
    if (!dataInicioStr || !dataFimStr) {
        alert("Preencha as datas inicial e final.");
        return;
    }

    const statusEl = document.getElementById('export-status');
    statusEl.textContent = "Buscando dados...";
    statusEl.className = "fluxo-status salvando";

    try {
        const dataInicio = new Date(dataInicioStr + 'T00:00:00');
        const dataFim = new Date(dataFimStr + 'T23:59:59');

        let todosRegistros = [];
        const tipos = [];
        if (incluirVendas) tipos.push('venda');
        if (incluirFluxo) tipos.push('fluxo');
        if (incluirPerdas) tipos.push('perda');

        for (let i = 0; i < tipos.length; i++) {
            const tipo = tipos[i];
            const snapshot = await db.collection('registros')
                .where('tipo', '==', tipo)
                .get();

            snapshot.forEach(doc => {
                const data = doc.data();
                data._id = doc.id;

                if (loja && data.loja !== loja) return;
                if (auditor && data.auditor && data.auditor.toLowerCase() !== auditor) return;
                if (data.dataHora) {
                    const ts = data.dataHora.toMillis();
                    if (ts < dataInicio.getTime() || ts > dataFim.getTime()) return;
                }
                todosRegistros.push(data);
            });
        }

        const fila = lerFila();
        fila.forEach(item => {
            if (tipos.indexOf(item.tipo) === -1) return;
            if (loja && item.loja !== loja) return;
            if (auditor && item.auditor && item.auditor.toLowerCase() !== auditor) return;

            if (item.dataHoraLocal) {
                const d = new Date(item.dataHoraLocal);
                if (d < dataInicio || d > dataFim) return;
                const itemFake = Object.assign({}, item);
                itemFake._origem = 'fila';
                itemFake.dataHora = {
                    toDate: function() { return d; },
                    toMillis: function() { return d.getTime(); }
                };
                todosRegistros.push(itemFake);
            }
        });

        if (todosRegistros.length === 0) {
            statusEl.textContent = "Nenhum registro encontrado no período.";
            statusEl.className = "fluxo-status";
            return;
        }

        todosRegistros.sort((a, b) => {
            const ta = a.dataHora ? a.dataHora.toMillis() : 0;
            const tb = b.dataHora ? b.dataHora.toMillis() : 0;
            return ta - tb;
        });

        const csv = gerarCSV(todosRegistros);
        baixarCSV(csv, `auditoria_${dataInicioStr}_a_${dataFimStr}.csv`);

        statusEl.textContent = `✓ ${todosRegistros.length} registros exportados!`;
        statusEl.className = "fluxo-status";

    } catch (error) {
        console.error("Erro ao exportar:", error);
        statusEl.textContent = "Erro: " + error.message;
        statusEl.className = "fluxo-status erro";
    }
}

// ============================================================
// GERAÇÃO DO CONTEÚDO CSV (4 seções)
// ============================================================
function gerarCSV(registros) {
    const SEP = ";";
    let linhas = [];

    // SEÇÃO 1: DETALHADO
    linhas.push("=== DETALHADO ===");
    linhas.push([
        "Data", "Hora", "Tipo", "Loja", "Auditor",
        "Valor (R$)", "Sexo", "Forma de Pagamento", "Motivo", "Observação",
        "Troca", "Virada",
        "Esp. M", "Esp. F", "Acomp. M", "Acomp. F", "Outros M", "Outros F"
    ].join(SEP));

    registros.forEach(reg => {
        let dataStr = "", horaStr = "";
        if (reg.dataHora) {
            const d = reg.dataHora.toDate();
            dataStr = String(d.getDate()).padStart(2, '0') + '/' +
                      String(d.getMonth() + 1).padStart(2, '0') + '/' +
                      d.getFullYear();
            horaStr = String(d.getHours()).padStart(2, '0') + ':' +
                      String(d.getMinutes()).padStart(2, '0');
        }

        linhas.push([
            dataStr,
            horaStr,
            reg.tipo || "",
            reg.loja || "",
            reg.auditor || "",
            reg.valor ? reg.valor.toFixed(2).replace('.', ',') : "",
            reg.sexo || "",
            reg.pagamento || "",
            reg.motivo || "",
            (reg.observacao || "").replace(/[\r\n;]/g, " "),
            reg.troca ? "Sim" : "",
            reg.virada ? "Sim" : "",
            reg.especulador_m != null ? reg.especulador_m : "",
            reg.especulador_f != null ? reg.especulador_f : "",
            reg.acompanhante_m != null ? reg.acompanhante_m : "",
            reg.acompanhante_f != null ? reg.acompanhante_f : "",
            reg.outros_m != null ? reg.outros_m : "",
            reg.outros_f != null ? reg.outros_f : ""
        ].join(SEP));
    });

    // SEÇÃO 2: RESUMO DE VENDAS
    linhas.push("");
    linhas.push("");
    linhas.push("=== RESUMO POR DIA E AUDITOR (VENDAS) ===");
    linhas.push(["Data", "Auditor", "Loja", "Qtd. Vendas", "Valor Total (R$)"].join(SEP));

    const resumoVendas = {};
    registros.forEach(reg => {
        if (reg.tipo !== 'venda' || !reg.dataHora) return;
        const d = reg.dataHora.toDate();
        const dataStr = String(d.getDate()).padStart(2, '0') + '/' +
                        String(d.getMonth() + 1).padStart(2, '0') + '/' +
                        d.getFullYear();
        const chave = dataStr + "|" + (reg.auditor || "") + "|" + (reg.loja || "");
        if (!resumoVendas[chave]) {
            resumoVendas[chave] = { data: dataStr, auditor: reg.auditor || "", loja: reg.loja || "", qtd: 0, total: 0 };
        }
        resumoVendas[chave].qtd++;
        resumoVendas[chave].total += parseFloat(reg.valor) || 0;
    });

    let totalGeral = 0, totalVendas = 0;
    Object.keys(resumoVendas).sort().forEach(chave => {
        const r = resumoVendas[chave];
        linhas.push([r.data, r.auditor, r.loja, r.qtd, r.total.toFixed(2).replace('.', ',')].join(SEP));
        totalGeral += r.total;
        totalVendas += r.qtd;
    });

    linhas.push("");
    linhas.push(["TOTAL GERAL", "", "", totalVendas, totalGeral.toFixed(2).replace('.', ',')].join(SEP));

    // SEÇÃO 3: RESUMO DE FLUXO
    linhas.push("");
    linhas.push("");
    linhas.push("=== RESUMO DE FLUXO POR DIA E AUDITOR ===");
    linhas.push([
        "Data", "Auditor", "Loja",
        "Esp. M", "Esp. F",
        "Acomp. M", "Acomp. F",
        "Outros M", "Outros F",
        "Total M", "Total F"
    ].join(SEP));

    const resumoFluxo = {};
    registros.forEach(reg => {
        if (reg.tipo !== 'fluxo' || !reg.dataHora) return;
        const d = reg.dataHora.toDate();
        const dataStr = String(d.getDate()).padStart(2, '0') + '/' +
                        String(d.getMonth() + 1).padStart(2, '0') + '/' +
                        d.getFullYear();
        const chave = dataStr + "|" + (reg.auditor || "") + "|" + (reg.loja || "");
        if (!resumoFluxo[chave]) {
            resumoFluxo[chave] = {
                data: dataStr, auditor: reg.auditor || "", loja: reg.loja || "",
                esp_m: 0, esp_f: 0, acomp_m: 0, acomp_f: 0, out_m: 0, out_f: 0
            };
        }
        resumoFluxo[chave].esp_m = reg.especulador_m || 0;
        resumoFluxo[chave].esp_f = reg.especulador_f || 0;
        resumoFluxo[chave].acomp_m = reg.acompanhante_m || 0;
        resumoFluxo[chave].acomp_f = reg.acompanhante_f || 0;
        resumoFluxo[chave].out_m = reg.outros_m || 0;
        resumoFluxo[chave].out_f = reg.outros_f || 0;
    });

    let tEspM = 0, tEspF = 0, tAcompM = 0, tAcompF = 0, tOutM = 0, tOutF = 0;

    Object.keys(resumoFluxo).sort().forEach(chave => {
        const r = resumoFluxo[chave];
        const totalM = r.esp_m + r.acomp_m + r.out_m;
        const totalF = r.esp_f + r.acomp_f + r.out_f;

        linhas.push([
            r.data, r.auditor, r.loja,
            r.esp_m, r.esp_f,
            r.acomp_m, r.acomp_f,
            r.out_m, r.out_f,
            totalM, totalF
        ].join(SEP));

        tEspM += r.esp_m; tEspF += r.esp_f;
        tAcompM += r.acomp_m; tAcompF += r.acomp_f;
        tOutM += r.out_m; tOutF += r.out_f;
    });

    linhas.push("");
    linhas.push([
        "TOTAL GERAL FLUXO", "", "",
        tEspM, tEspF,
        tAcompM, tAcompF,
        tOutM, tOutF,
        tEspM + tAcompM + tOutM,
        tEspF + tAcompF + tOutF
    ].join(SEP));

    // SEÇÃO 4: RESUMO DE PERDAS
    linhas.push("");
    linhas.push("");
    linhas.push("=== RESUMO DE PERDAS POR MOTIVO ===");
    linhas.push(["Motivo", "Quantidade"].join(SEP));

    const resumoPerdas = {};
    registros.forEach(reg => {
        if (reg.tipo !== 'perda') return;
        const motivo = reg.motivo || "Não informado";
        if (!resumoPerdas[motivo]) resumoPerdas[motivo] = 0;
        resumoPerdas[motivo]++;
    });

    let totalPerdas = 0;
    Object.keys(resumoPerdas).sort().forEach(motivo => {
        linhas.push([motivo, resumoPerdas[motivo]].join(SEP));
        totalPerdas += resumoPerdas[motivo];
    });

    linhas.push("");
    linhas.push(["TOTAL DE PERDAS", totalPerdas].join(SEP));

    return linhas.join("\r\n");
}

// ============================================================
// DOWNLOAD DO CSV
// ============================================================
function baixarCSV(conteudo, nomeArquivo) {
    const bom = "\uFEFF";
    const blob = new Blob([bom + conteudo], { type: 'text/csv;charset=utf-8;' });

    if (navigator.msSaveBlob) {
        navigator.msSaveBlob(blob, nomeArquivo);
        return;
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = nomeArquivo;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();

    setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }, 100);
}

// ============================================================
// PAINEL DE SINCRONIZAÇÃO GLOBAL (ADMIN)
// ============================================================

// Mostra/esconde o painel do admin
function atualizarPainelAdmin() {
    const painel = document.getElementById('painel-admin-sync');
    const btnSync = document.getElementById('btn-sync-admin');
    
    if (!painel || !btnSync) return;

    if (ehAdmin()) {
        painel.style.display = 'block';
        btnSync.style.display = 'inline-block';
        atualizarInfoPainelAdmin();
    } else {
        painel.style.display = 'none';
        btnSync.style.display = 'none';
    }
}

// Atualiza os dados do painel (contagem, última sync, status)
function atualizarInfoPainelAdmin() {
    const fila = lerFila();
    const qtdEl = document.getElementById('admin-qtd-fila');
    if (qtdEl) qtdEl.textContent = fila.length;

    const ultimaEl = document.getElementById('admin-ultima-sync');
    if (ultimaEl) {
        const ultima = localStorage.getItem('auditoria_ultima_sync');
        if (ultima) {
            const d = new Date(ultima);
            const dia = String(d.getDate()).padStart(2, '0');
            const mes = String(d.getMonth() + 1).padStart(2, '0');
            const hora = String(d.getHours()).padStart(2, '0');
            const min = String(d.getMinutes()).padStart(2, '0');
            ultimaEl.textContent = `${dia}/${mes} às ${hora}:${min}`;
        } else {
            ultimaEl.textContent = "Nunca";
        }
    }
}

// Função chamada pelo botão "Sincronizar Tudo Agora"
async function sincronizarTudoAdmin() {
    if (!ehAdmin()) {
        alert("Apenas o administrador pode usar esta função.");
        return;
    }

    const statusEl = document.getElementById('admin-status-sync');
    const btnSync = document.getElementById('btn-sync-admin');

    // Verifica se está online
    if (!estaOnline()) {
        alert("Sem internet no momento. Conecte-se e tente novamente.");
        return;
    }

    // Garante que está autenticado no Firebase
    if (!auth.currentUser) {
        const sessao = lerSessaoOffline();
        if (!sessao) {
            alert("Sessão expirada. Faça login novamente.");
            return;
        }
        const senha = prompt("Digite sua senha para reautenticar (" + sessao.usuario + "):");
        if (!senha) return;

        try {
            const emailFake = sessao.usuario + DOMINIO_FICTICIO;
            await auth.signInWithEmailAndPassword(emailFake, senha);
            usuarioLogado = sessao.usuario;
            await salvarCredencial(sessao.usuario, senha);
        } catch (err) {
            alert("Falha ao reautenticar. Verifique a senha.");
            return;
        }
    }

    const fila = lerFila();
    if (fila.length === 0) {
        if (statusEl) statusEl.textContent = "Nada para sincronizar.";
        alert("Não há itens pendentes neste dispositivo.");
        return;
    }

    if (statusEl) statusEl.textContent = "Sincronizando " + fila.length + " item(ns)...";
    if (btnSync) btnSync.disabled = true;

    let sucesso = 0;
    let falhas = 0;

    for (let i = 0; i < fila.length; i++) {
        const item = fila[i];
        try {
            const dados = Object.assign({}, item);
            delete dados._localId;
            delete dados._dataLocal;

            if (dados.dataHoraLocal) {
                dados.dataHora = firebase.firestore.Timestamp.fromDate(new Date(dados.dataHoraLocal));
                delete dados.dataHoraLocal;
            } else if (!dados.dataHora) {
                dados.dataHora = firebase.firestore.FieldValue.serverTimestamp();
            }

            if (dados._docId) {
                const docId = dados._docId;
                delete dados._docId;
                await db.collection('registros').doc(docId).set(dados, { merge: true });
            } else {
                await db.collection('registros').add(dados);
            }

            removerDaFila(item._localId);
            sucesso++;

            if (statusEl) statusEl.textContent = `Sincronizando... (${sucesso}/${fila.length})`;

        } catch (err) {
            console.error("✗ Erro ao sincronizar item:", err);
            falhas++;
        }
    }

    // Registra o momento da última sincronização
    localStorage.setItem('auditoria_ultima_sync', new Date().toISOString());

    if (btnSync) btnSync.disabled = false;

    if (statusEl) {
        if (falhas === 0) {
            statusEl.textContent = `✓ ${sucesso} item(ns) sincronizado(s)!`;
        } else {
            statusEl.textContent = `⚠ ${sucesso} OK / ${falhas} falha(s)`;
        }
    }

    // Registra a sincronização no Firebase (opcional: log de auditoria)
    try {
        await db.collection('sincronizacoes').add({
            admin: usuarioLogado,
            total: fila.length,
            sucesso: sucesso,
            falhas: falhas,
            dataHora: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) {
        console.warn("Não foi possível registrar a sincronização:", e);
    }

    // Atualiza a UI
    atualizarInfoPainelAdmin();
    atualizarIndicadorFila();
}

// Intercepta a sincronização normal para atualizar o painel do admin
const _sincronizarFilaOriginal = sincronizarFila;
window.sincronizarFila = async function(silencioso) {
    await _sincronizarFilaOriginal(silencioso);
    atualizarInfoPainelAdmin();
};

// ... (todas as funções acima)

// ============================================================
// RETRY AUTOMÁTICO: tenta sincronizar a cada 30 segundos
// ============================================================
setInterval(() => {
    if (lerFila().length > 0 && estaOnline() && auth.currentUser) {
        sincronizarFila(true);
    }
    // Atualiza o painel do admin a cada 30s
    if (ehAdmin()) {
        atualizarInfoPainelAdmin();
    }
}, 30000);

// ============================================================
// INICIALIZAÇÃO
// ============================================================
window.onload = () => {
    auth.onAuthStateChanged((user) => {
        // ... resto do código
    });
};

// ============================================================
// INICIALIZAÇÃO
// ============================================================
window.onload = () => {
    auth.onAuthStateChanged((user) => {
        if (user) {
            usuarioLogado = user.email.split('@')[0];
            salvarSessaoOffline(usuarioLogado);
            carregarLojas();
            mostrarTela('tela-lojas');
        } else {
            const sessaoOff = lerSessaoOffline();
            if (sessaoOff && sessaoOff.usuario) {
                usuarioLogado = sessaoOff.usuario;
                carregarLojas();
                mostrarTela('tela-lojas');
            } else {
                mostrarTela('tela-login');
            }
        }
        atualizarIndicadorFila();
        atualizarStatusConexao();
        setTimeout(sincronizarFila, 2000);
    });
};