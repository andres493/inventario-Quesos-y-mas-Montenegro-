// Sistema de Inventario - Local First (sin servidor)
// Entidades: Producto, Movimiento
// Persistencia: localStorage con una clave por dataset
// Stock: suma entradas/ajustes+ menos salidas/ajustes-
// Costo: promedio móvil por producto

const STORAGE_KEYS = {
  productos: 'inv.productos.v1',
  movimientos: 'inv.movimientos.v1',
  meta: 'inv.meta.v1'
};

function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function today() { return new Date().toISOString().slice(0,10); }
function toNumber(n, d=0) { const x = Number(n); return Number.isFinite(x) ? x : d; }
function formatMoney(n) { return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0); }
function toast(msg, type='ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderLeftColor = type === 'error' ? '#ef4444' : (type==='warn' ? '#f59e0b' : '#22c55e');
  el.classList.add('show');
  setTimeout(()=> el.classList.remove('show'), 2500);
}

class Store {
  static read(key, def) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : def; } catch { return def; }
  }
  static write(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  static backup() {
    const payload = {
      version: 1,
      at: new Date().toISOString(),
      datos: {
        productos: Store.read(STORAGE_KEYS.productos, []),
        movimientos: Store.read(STORAGE_KEYS.movimientos, []),
        meta: Store.read(STORAGE_KEYS.meta, {})
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `inventario_backup_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  static async restore(file) {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!payload || !payload.datos) throw new Error('Respaldo inválido');
    Store.write(STORAGE_KEYS.productos, payload.datos.productos || []);
    Store.write(STORAGE_KEYS.movimientos, payload.datos.movimientos || []);
    Store.write(STORAGE_KEYS.meta, payload.datos.meta || {});
  }
}

class InventarioService {
  constructor() {
    this.productos = Store.read(STORAGE_KEYS.productos, []);
    this.movimientos = Store.read(STORAGE_KEYS.movimientos, []);
    this.indexProductos();
  }
  indexProductos() {
    this.bySKU = new Map(this.productos.map(p => [p.sku.toUpperCase(), p]));
  }
  save() {
    Store.write(STORAGE_KEYS.productos, this.productos);
    Store.write(STORAGE_KEYS.movimientos, this.movimientos);
    this.indexProductos();
  }
  // Productos
  listarProductos(query={}) {
    const { texto = '', categoria = '' } = query;
    const q = texto.trim().toUpperCase();
    return this.productos.filter(p => {
      const okTexto = q ? (p.sku.toUpperCase().includes(q) || p.nombre.toUpperCase().includes(q)) : true;
      const okCat = categoria ? (p.categoria||'') === categoria : true;
      return okTexto && okCat;
    }).map(p => ({...p, stock: this.stockDe(p.sku), costoProm: this.costoPromedioDe(p.sku)}));
  }
  upsertProducto(data) {
    if (!data || !data.sku) throw new Error('SKU requerido');
    const sku = data.sku.trim().toUpperCase();
    if (!sku) throw new Error('SKU requerido');
    const existente = this.bySKU.get(sku);
    const base = {
      id: existente?.id || uid(),
      sku,
      nombre: data.nombre?.trim() || '',
      categoria: data.categoria?.trim() || '',
      unidad: data.unidad?.trim() || '',
      precio: toNumber(data.precio, 0),
      costo: toNumber(data.costo, 0),
      minimo: toNumber(data.minimo, 0),
      activo: data.activo !== undefined ? (data.activo === true || data.activo === 'true') : true,
      attrs: data.attrs || existente?.attrs || {}
    };
    if (existente) {
      Object.assign(existente, base);
    } else {
      this.productos.push(base);
    }
    this.save();
    return base;
  }
  eliminarProducto(sku) {
    const SKU = sku.toUpperCase();
    const i = this.productos.findIndex(p => p.sku.toUpperCase() === SKU);
    if (i >= 0) {
      this.productos.splice(i,1);
      this.save();
    }
  }
  // Movimientos
  registrarMovimiento(mov) {
    const tipo = mov.tipo;
    const sku = mov.sku?.trim().toUpperCase();
    if (!['ENTRADA','SALIDA','AJUSTE+','AJUSTE-'].includes(tipo)) throw new Error('Tipo inválido');
    if (!sku) throw new Error('SKU requerido');
    const prod = this.bySKU.get(sku);
    if (!prod) throw new Error('Producto no existe');

    const cantidad = toNumber(mov.cantidad, 0);
    if (cantidad <= 0) throw new Error('Cantidad inválida');

    const fecha = mov.fecha || today();
    const nuevo = {
      id: uid(),
      fecha,
      tipo,
      sku,
      cantidad,
      costo: tipo === 'ENTRADA' || tipo === 'AJUSTE+' ? toNumber(mov.costo, prod.costo) : undefined,
      precio: tipo === 'SALIDA' ? toNumber(mov.precio, prod.precio) : undefined,
      doc: (mov.doc||'').trim(),
      nota: (mov.nota||'').trim()
    };

    // Validaciones de stock disponible en salidas y ajuste negativo
    const stockActual = this.stockDe(sku);
    if ((tipo === 'SALIDA' || tipo === 'AJUSTE-') && cantidad > stockActual) {
      throw new Error(`Stock insuficiente. Disponible: ${stockActual}`);
    }

    // Actualizar costo promedio en entradas y ajuste+
    if (tipo === 'ENTRADA' || tipo === 'AJUSTE+') {
      const saldoValor = this.costoPromedioDe(sku) * stockActual;
      const nuevoSaldoCant = stockActual + cantidad;
      const nuevoCostoProm = nuevoSaldoCant > 0 ? (saldoValor + (nuevo.costo * cantidad)) / nuevoSaldoCant : prod.costo;
      prod.costo = Number(nuevoCostoProm.toFixed(6));
    }

    this.movimientos.push(nuevo);
    this.save();
    return nuevo;
  }
  eliminarMovimiento(id) {
    const i = this.movimientos.findIndex(m => m.id === id);
    if (i >= 0) {
      // Para consistencia del costo promedio, recomputar costos desde cero al eliminar
      this.movimientos.splice(i,1);
      this.recalcularCostos();
      this.save();
    }
  }
  recalcularCostos() {
    // Recalcula costos promedio por producto recorriendo movimientos por fecha
    const bySku = new Map(this.productos.map(p => [p.sku, { p, stock: 0, costo: toNumber(p.costo,0) }]));
    const ordenados = [...this.movimientos].sort((a,b)=> a.fecha.localeCompare(b.fecha));
    for (const m of ordenados) {
      const entry = bySku.get(m.sku);
      if (!entry) continue;
      if (m.tipo === 'ENTRADA' || m.tipo === 'AJUSTE+') {
        const saldoVal = entry.costo * entry.stock;
        const nuevoSaldo = entry.stock + m.cantidad;
        const nuevoCosto = nuevoSaldo > 0 ? (saldoVal + (toNumber(m.costo, entry.costo) * m.cantidad)) / nuevoSaldo : entry.costo;
        entry.stock = nuevoSaldo;
        entry.costo = nuevoCosto;
      } else if (m.tipo === 'SALIDA' || m.tipo === 'AJUSTE-') {
        entry.stock = Math.max(0, entry.stock - m.cantidad);
      }
    }
    // Asigna costo final promedio a productos
    for (const {p, costo} of bySku.values()) {
      p.costo = Number(toNumber(costo,0).toFixed(6));
    }
  }
  // Cálculos
  stockDe(sku) {
    const SKU = sku.toUpperCase();
    let s = 0;
    for (const m of this.movimientos) {
      if (m.sku !== SKU) continue;
      if (m.tipo === 'ENTRADA' || m.tipo === 'AJUSTE+') s += m.cantidad;
      if (m.tipo === 'SALIDA' || m.tipo === 'AJUSTE-') s -= m.cantidad;
    }
    return Number(s.toFixed(6));
  }
  costoPromedioDe(sku) {
    const prod = this.bySKU.get(sku.toUpperCase());
    return toNumber(prod?.costo, 0);
  }
  kardex(sku) {
    const SKU = sku.toUpperCase();
    const mvs = this.movimientos.filter(m => m.sku === SKU).sort((a,b)=> a.fecha.localeCompare(b.fecha));
    let saldo = 0; let costo = this.costoPromedioDe(SKU);
    return mvs.map(m => {
      let entrada = ''; let salida = '';
      if (m.tipo === 'ENTRADA' || m.tipo === 'AJUSTE+') {
        entrada = m.cantidad;
        const saldoVal = costo * saldo;
        const nuevoSaldo = saldo + m.cantidad;
        costo = nuevoSaldo > 0 ? (saldoVal + (toNumber(m.costo, costo) * m.cantidad)) / nuevoSaldo : costo;
        saldo = nuevoSaldo;
      } else {
        salida = m.cantidad;
        saldo = Math.max(0, saldo - m.cantidad);
      }
      return { ...m, entrada, salida, saldo: Number(saldo.toFixed(6)), costoProm: Number(costo.toFixed(6)) };
    });
  }
  resumen() {
    const prods = this.productos.map(p => {
      const stock = this.stockDe(p.sku);
      const costo = this.costoPromedioDe(p.sku);
      return { sku: p.sku, nombre: p.nombre, stock, costo, valorizado: stock * costo, minimo: p.minimo };
    });
    const totalProductos = this.productos.length;
    const stockTotal = prods.reduce((a,b)=> a + b.stock, 0);
    const valorizado = prods.reduce((a,b)=> a + b.valorizado, 0);
    const bajoMin = prods.filter(x => x.stock < x.minimo);
    return { totalProductos, stockTotal, valorizado, bajoMin, prods };
  }
}

// UI
const svc = new InventarioService();

function renderTabs() {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');
  tabs.forEach(tab => tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    panels.forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const sel = tab.getAttribute('data-target');
    document.querySelector(sel).classList.add('active');
    if (sel === '#dashboard') renderDashboard();
    if (sel === '#productos') renderProductos();
    if (sel === '#movimientos') renderMovimientos();
    if (sel === '#reportes') renderReportes();
  }));
}

// Dashboard
function renderDashboard() {
  const { totalProductos, stockTotal, valorizado, bajoMin } = svc.resumen();
  document.getElementById('metricTotalProductos').textContent = totalProductos;
  document.getElementById('metricStockTotal').textContent = Number(stockTotal.toFixed(4));
  document.getElementById('metricValorizado').textContent = formatMoney(valorizado);
  document.getElementById('metricBajoMinimo').textContent = bajoMin.length;

  const tbody = document.querySelector('#tablaBajoMinimo tbody');
  tbody.innerHTML = '';
  for (const p of bajoMin) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${p.sku}</td><td>${p.nombre}</td><td>${p.stock}</td><td>${p.minimo}</td>`;
    tbody.appendChild(tr);
  }
}

// Productos
function fillCategorias() {
  const sel = document.getElementById('filtroCategoria');
  const cats = Array.from(new Set(svc.productos.map(p => p.categoria).filter(Boolean)));
  sel.innerHTML = '<option value="">Todas las categorías</option>' + cats.map(c => `<option value="${c}">${c}</option>`).join('');
}
function renderProductos() {
  fillCategorias();
  const texto = document.getElementById('buscarProducto').value;
  const categoria = document.getElementById('filtroCategoria').value;
  const data = svc.listarProductos({ texto, categoria });
  const tbody = document.querySelector('#tablaProductos tbody');
  tbody.innerHTML = '';
  for (const p of data) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.sku}</td>
      <td>${p.nombre}</td>
      <td>${p.categoria||''}</td>
      <td>${p.unidad||''}</td>
      <td>${formatMoney(p.precio||0)}</td>
      <td>${Number(p.stock.toFixed(4))}</td>
      <td>${Number(p.minimo||0)}</td>
      <td class="actions">
        <button class="btn small" data-act="edit" data-sku="${p.sku}">Editar</button>
        <button class="btn small danger" data-act="del" data-sku="${p.sku}">Eliminar</button>
      </td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('button[data-act="edit"]').forEach(btn => btn.addEventListener('click', () => openModalProducto(btn.dataset.sku)));
  tbody.querySelectorAll('button[data-act="del"]').forEach(btn => btn.addEventListener('click', () => {
    const sku = btn.dataset.sku;
    if (!confirm(`¿Eliminar producto ${sku}?`)) return;
    svc.eliminarProducto(sku);
    toast('Producto eliminado');
    renderAll();
  }));

  // actualiza datalist de SKUs para movimientos
  const dl = document.getElementById('skuList');
  dl.innerHTML = svc.productos.map(p => `<option value="${p.sku}">${p.nombre}</option>`).join('');
}

function openModalProducto(sku) {
  const dlg = document.getElementById('modalProducto');
  const titulo = document.getElementById('modalProductoTitulo');
  const form = document.getElementById('formProducto');
  const isEdit = !!sku;
  titulo.textContent = isEdit ? 'Editar Producto' : 'Nuevo Producto';
  form.reset();
  document.getElementById('customAttrs').innerHTML = '';

  let data = { sku:'', nombre:'', categoria:'', unidad:'', costo:0, precio:0, minimo:0, activo:true, attrs:{} };
  if (isEdit) {
    const p = svc.bySKU.get(sku.toUpperCase());
    if (p) data = JSON.parse(JSON.stringify(p));
  }

  // set values
  document.getElementById('prodSku').value = data.sku;
  document.getElementById('prodNombre').value = data.nombre;
  document.getElementById('prodCategoria').value = data.categoria||'';
  document.getElementById('prodUnidad').value = data.unidad||'';
  document.getElementById('prodCosto').value = data.costo||0;
  document.getElementById('prodPrecio').value = data.precio||0;
  document.getElementById('prodMinimo').value = data.minimo||0;
  document.getElementById('prodActivo').value = String(data.activo !== false);

  // atributos
  for (const [k,v] of Object.entries(data.attrs||{})) addCustomAttrRow(k, v);

  dlg.returnValue = '';
  dlg.showModal();

  const onSubmit = (ev) => {
    ev.preventDefault();
    const attrs = collectCustomAttrs();
    try {
      svc.upsertProducto({
        sku: document.getElementById('prodSku').value,
        nombre: document.getElementById('prodNombre').value,
        categoria: document.getElementById('prodCategoria').value,
        unidad: document.getElementById('prodUnidad').value,
        costo: document.getElementById('prodCosto').value,
        precio: document.getElementById('prodPrecio').value,
        minimo: document.getElementById('prodMinimo').value,
        activo: document.getElementById('prodActivo').value,
        attrs
      });
      dlg.close('confirm');
      toast('Producto guardado');
      renderAll();
    } catch (e) { toast(e.message||String(e), 'error'); }
  };

  form.onsubmit = onSubmit;

  document.getElementById('btnAddAttr').onclick = () => {
    const k = document.getElementById('newAttrKey').value.trim();
    const v = document.getElementById('newAttrValue').value.trim();
    if (!k) return;
    addCustomAttrRow(k, v);
    document.getElementById('newAttrKey').value = '';
    document.getElementById('newAttrValue').value = '';
  };
}

function addCustomAttrRow(key, value) {
  const wrap = document.getElementById('customAttrs');
  const row = document.createElement('div');
  row.className = 'custom-attr';
  row.innerHTML = `<input data-k placeholder="Atributo" value="${key||''}" /><input data-v placeholder="Valor" value="${value||''}" /> <button class="btn small" type="button">✕</button>`;
  row.querySelector('button').onclick = () => row.remove();
  wrap.appendChild(row);
}

function collectCustomAttrs() {
  const res = {};
  document.querySelectorAll('#customAttrs .custom-attr').forEach(row => {
    const k = row.querySelector('input[data-k]').value.trim();
    const v = row.querySelector('input[data-v]').value.trim();
    if (k) res[k] = v;
  });
  return res;
}

// Movimientos
function renderMovimientos() {
  const filtroTexto = document.getElementById('buscarMovimiento').value.trim().toUpperCase();
  const filtroTipo = document.getElementById('filtroTipoMovimiento').value;
  const tbody = document.querySelector('#tablaMovimientos tbody');
  tbody.innerHTML = '';
  const datos = svc.movimientos.filter(m => {
    const okTipo = filtroTipo ? m.tipo === filtroTipo : true;
    const okTexto = filtroTexto ? (m.sku.includes(filtroTexto) || (m.doc||'').toUpperCase().includes(filtroTexto)) : true;
    return okTipo && okTexto;
  }).sort((a,b)=> b.fecha.localeCompare(a.fecha));

  for (const m of datos) {
    const p = svc.bySKU.get(m.sku);
    const costoPrecio = m.tipo === 'SALIDA' ? (m.precio !== undefined ? formatMoney(m.precio) : '-') : (m.costo !== undefined ? formatMoney(m.costo) : '-');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${m.fecha}</td>
      <td>${m.tipo}</td>
      <td>${m.sku}</td>
      <td>${p?.nombre||''}</td>
      <td>${m.cantidad}</td>
      <td>${costoPrecio}</td>
      <td>${m.doc||''}</td>
      <td>${m.nota||''}</td>
      <td><button class="btn small danger" data-id="${m.id}">Eliminar</button></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('button[data-id]').forEach(btn => btn.addEventListener('click', () => {
    if (!confirm('¿Eliminar movimiento? Esto recalculará costos.')) return;
    svc.eliminarMovimiento(btn.dataset.id);
    toast('Movimiento eliminado');
    renderAll();
  }));
}

function openModalMovimiento() {
  const dlg = document.getElementById('modalMovimiento');
  const form = document.getElementById('formMovimiento');
  form.reset();
  document.getElementById('movFecha').value = today();
  dlg.returnValue = '';
  dlg.showModal();

  form.onsubmit = (ev) => {
    ev.preventDefault();
    try {
      svc.registrarMovimiento({
        tipo: document.getElementById('movTipo').value,
        fecha: document.getElementById('movFecha').value,
        sku: document.getElementById('movSku').value,
        cantidad: document.getElementById('movCantidad').value,
        costo: document.getElementById('movCosto').value,
        precio: document.getElementById('movPrecio').value,
        doc: document.getElementById('movDoc').value,
        nota: document.getElementById('movNota').value
      });
      dlg.close('confirm');
      toast('Movimiento registrado');
      renderAll();
    } catch (e) { toast(e.message||String(e), 'error'); }
  };
}

// Reportes
function renderReportes() {
  // kardex vacía por defecto
  document.querySelector('#tablaKardex tbody').innerHTML = '';
  // valorizado
  const tbody = document.querySelector('#tablaValorizado tbody');
  tbody.innerHTML = '';
  const { prods } = svc.resumen();
  for (const r of prods) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.sku}</td><td>${r.nombre}</td><td>${Number(r.stock.toFixed(4))}</td><td>${formatMoney(r.costo)}</td><td>${formatMoney(r.valorizado)}</td>`;
    tbody.appendChild(tr);
  }
}

function verKardex() {
  const sku = document.getElementById('kardexSKU').value.trim();
  if (!sku) { toast('Ingresa un SKU', 'warn'); return; }
  const data = svc.kardex(sku);
  const tbody = document.querySelector('#tablaKardex tbody');
  tbody.innerHTML = '';
  for (const k of data) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${k.fecha}</td>
      <td>${k.tipo}</td>
      <td>${k.entrada||''}</td>
      <td>${k.salida||''}</td>
      <td>${k.saldo}</td>
      <td>${formatMoney(k.costoProm)}</td>
      <td>${k.doc||''}</td>
      <td>${k.nota||''}</td>`;
    tbody.appendChild(tr);
  }
}

// Exportaciones CSV
function exportCSV() {
  const lines = [];
  // productos
  lines.push('# Productos');
  lines.push('SKU,Nombre,Categoria,Unidad,Precio,Costo,Minimo,Activo,StockActual');
  for (const p of svc.listarProductos({})) {
    lines.push([p.sku, p.nombre, p.categoria||'', p.unidad||'', p.precio||0, p.costo||0, p.minimo||0, p.activo!==false, p.stock||0].join(','));
  }
  lines.push('');
  // movimientos
  lines.push('# Movimientos');
  lines.push('Fecha,Tipo,SKU,Cantidad,Costo,Precio,Documento,Nota');
  for (const m of svc.movimientos) {
    lines.push([m.fecha, m.tipo, m.sku, m.cantidad, m.costo||'', m.precio||'', m.doc||'', (m.nota||'').replaceAll('\n',' ')].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `inventario_export_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Respaldo/Restauración
function doBackup() { Store.backup(); }
async function doRestore(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    await Store.restore(file);
    Object.assign(svc, new InventarioService());
    toast('Respaldo restaurado');
    renderAll();
  } catch (e) { toast(e.message||String(e), 'error'); }
  finally { ev.target.value = ''; }
}

// Eventos globales
function bindEvents() {
  document.getElementById('btnNuevoProducto').addEventListener('click', () => openModalProducto());
  document.getElementById('buscarProducto').addEventListener('input', renderProductos);
  document.getElementById('filtroCategoria').addEventListener('change', renderProductos);

  document.getElementById('btnNuevoMovimiento').addEventListener('click', openModalMovimiento);
  document.getElementById('buscarMovimiento').addEventListener('input', renderMovimientos);
  document.getElementById('filtroTipoMovimiento').addEventListener('change', renderMovimientos);

  document.getElementById('btnVerKardex').addEventListener('click', verKardex);

  document.getElementById('btnExportCSV').addEventListener('click', exportCSV);
  document.getElementById('btnBackup').addEventListener('click', doBackup);
  document.getElementById('btnRestore').addEventListener('click', () => document.getElementById('restoreFile').click());
  document.getElementById('restoreFile').addEventListener('change', doRestore);

  // Tabs iniciales
  renderTabs();
}

function renderAll() {
  renderDashboard();
  renderProductos();
  renderMovimientos();
  renderReportes();
}

// Init
bindEvents();
renderAll();
