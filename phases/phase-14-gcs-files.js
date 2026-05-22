// ============================================================================
// PHASE 14: Migracion de archivos a GCS (con REEMPLAZO desde v1)
// ============================================================================
// MODIFICADO 2026-05-21:
//   Re-lee la fuente original de v1 (por legacy_id), NO la columna v2 (que
//   tras la primera migracion ya apunta a GCS). Asi cada re-run sincroniza
//   v1 -> GCS: sube el archivo actual de v1, sobrescribe, y borra versiones
//   viejas del mismo slot. Garantiza 1 archivo por persona/tipo, siempre el
//   de v1, sin acumular.
//
//   - Slots de 1 archivo (customers docs, invoices, POs, system_files):
//     replaceFileSingle -> borra los demas objetos del folder del slot.
//   - product_images (varias por producto): replaceFileVersioned -> path
//     deterministico por legacy_id, sin borrar otras imagenes del producto.
//
//   Requiere GCS habilitado (GCS_CREDENTIALS valido). Si GCS no inicializa,
//   la fase aborta sin tocar datos.
// ============================================================================

const logger = require('../utils/logger');
const config = require('../config');

const GCS_PREFIX = 'https://storage.googleapis.com/';

function gcsUrl(gcsPathOrUrl) {
  if (!gcsPathOrUrl) return null;
  if (gcsPathOrUrl.startsWith('http')) return gcsPathOrUrl; // ya es URL (externa o GCS)
  return `${GCS_PREFIX}${config.gcs.bucketName}/${gcsPathOrUrl}`;
}

module.exports = async function phase14(v1Pool, v2Pool) {
  logger.phase('14', 'Migración de Archivos a GCS (reemplazo desde v1)');

  const gcsUploader = require('../utils/gcs-uploader');
  const ready = await gcsUploader.init();
  if (!ready) {
    logger.error('  GCS no disponible (revisar GCS_CREDENTIALS). Abortando fase 14.');
    return { migrated: 0, skipped: 0, failed: 0, errors: [{ error: 'GCS not available' }] };
  }
  const { replaceFileSingle, replaceFileVersioned } = gcsUploader;

  const results = { migrated: 0, skipped: 0, failed: 0, errors: [] };

  const updateColumn = async (table, column, id, url) => {
    await v2Pool.query(
      `UPDATE ${table} SET ${column} = $1, updated_at = NOW() WHERE id = $2`,
      [url, id]
    );
  };

  // ==========================================================================
  // 1) customers — 5 slots de 1 archivo c/u (photo, contract, ine, bank, tax)
  // ==========================================================================
  {
    logger.table('customers', 'Sincronizando documentos de clientes a GCS');
    // Fuente v1: t_customers por id_customers (= customers.legacy_id)
    const v1Rows = await v1Pool.query(`
      SELECT id_customers,
             file_photo_customers, file_contract, file_ine,
             file_cuenta_bancaria, file_constancia_fiscal
      FROM toniclife.t_customers
    `);
    const v1Map = new Map(v1Rows.rows.map(r => [String(r.id_customers), r]));

    const SLOTS = [
      { column: 'photo_url',           v1col: 'file_photo_customers',   sub: 'photo',          canonical: 'photo' },
      { column: 'contract_url',        v1col: 'file_contract',          sub: 'contract',       canonical: 'contract' },
      { column: 'ine_document_url',    v1col: 'file_ine',               sub: 'ine',            canonical: 'ine' },
      { column: 'bank_statement_url',  v1col: 'file_cuenta_bancaria',   sub: 'bank-statement', canonical: 'bank-statement' },
      { column: 'tax_id_document_url', v1col: 'file_constancia_fiscal', sub: 'tax-id',         canonical: 'tax-id' },
    ];

    const { rows: customers } = await v2Pool.query(
      `SELECT id, legacy_id FROM tonic.customers WHERE legacy_id IS NOT NULL`
    );
    logger.info(`    ${customers.length} clientes a revisar (${SLOTS.length} slots c/u)`);

    let i = 0;
    for (const cust of customers) {
      const src = v1Map.get(String(cust.legacy_id));
      if (src) {
        for (const slot of SLOTS) {
          const rawPath = src[slot.v1col];
          if (!rawPath || String(rawPath).trim() === '') continue;
          try {
            const folder = `customers/${cust.legacy_id}/${slot.sub}`;
            const res = await replaceFileSingle(rawPath, folder, slot.canonical);
            if (res) {
              await updateColumn('tonic.customers', slot.column, cust.id, gcsUrl(res));
              results.migrated++;
            } else {
              results.skipped++;
            }
          } catch (err) {
            results.failed++;
            if (results.errors.length < 200) {
              results.errors.push({ table: 'customers', column: slot.column, id: cust.id, error: err.message });
            }
          }
        }
      }
      if (++i % 500 === 0) logger.progress('customers', i, customers.length);
    }
  }

  // ==========================================================================
  // 2) product_images — varias por producto (replaceFileVersioned)
  // ==========================================================================
  {
    logger.table('product_images', 'Sincronizando imágenes de producto a GCS');
    const v1Rows = await v1Pool.query(`SELECT id_photo, file_photo FROM toniclife.t_product_photo`);
    const v1Map = new Map(v1Rows.rows.map(r => [String(r.id_photo), r.file_photo]));

    const { rows: images } = await v2Pool.query(
      `SELECT id, legacy_id, product_id FROM tonic.product_images WHERE legacy_id IS NOT NULL`
    );
    logger.info(`    ${images.length} imágenes a revisar`);

    let i = 0;
    for (const img of images) {
      const rawPath = v1Map.get(String(img.legacy_id));
      if (rawPath && String(rawPath).trim() !== '') {
        try {
          const folder = `products/images/${img.product_id}`;
          const res = await replaceFileVersioned(rawPath, folder, `img-${img.legacy_id}`);
          if (res) {
            await updateColumn('tonic.product_images', 'image_url', img.id, gcsUrl(res));
            results.migrated++;
          } else {
            results.skipped++;
          }
        } catch (err) {
          results.failed++;
          if (results.errors.length < 200) {
            results.errors.push({ table: 'product_images', id: img.id, error: err.message });
          }
        }
      }
      if (++i % 500 === 0) logger.progress('product_images', i, images.length);
    }
  }

  // ==========================================================================
  // 3) invoices — XML por factura (1 archivo por slot). Fuentes v1 con offsets:
  //    sale: t_factura_libre.name_path (legacy_id = id_factura_libre)
  //    commission: t_bono_facturama.path_file (legacy_id = id + 10,000,000)
  // ==========================================================================
  {
    logger.table('invoices', 'Sincronizando XMLs de facturas a GCS');
    const saleRows = await v1Pool.query(`SELECT id_factura_libre, name_path FROM toniclife.t_factura_libre`);
    const saleMap = new Map(saleRows.rows.map(r => [String(r.id_factura_libre), r.name_path]));
    const bonoRows = await v1Pool.query(`SELECT id, path_file FROM toniclife.t_bono_facturama`);
    const bonoMap = new Map(bonoRows.rows.map(r => [String(Number(r.id) + 10000000), r.path_file]));

    const { rows: invoices } = await v2Pool.query(
      `SELECT id, legacy_id FROM tonic.invoices
       WHERE legacy_id IS NOT NULL AND invoice_type IN ('sale','commission')`
    );
    logger.info(`    ${invoices.length} facturas a revisar`);

    let i = 0;
    for (const inv of invoices) {
      const key = String(inv.legacy_id);
      const rawPath = saleMap.get(key) || bonoMap.get(key);
      if (rawPath && String(rawPath).trim() !== '') {
        try {
          const folder = `invoices/xml/${inv.legacy_id}`;
          const res = await replaceFileSingle(rawPath, folder, 'invoice');
          if (res) {
            await updateColumn('tonic.invoices', 'xml_file_path', inv.id, gcsUrl(res));
            results.migrated++;
          } else {
            results.skipped++;
          }
        } catch (err) {
          results.failed++;
          if (results.errors.length < 200) {
            results.errors.push({ table: 'invoices', id: inv.id, error: err.message });
          }
        }
      }
      if (++i % 500 === 0) logger.progress('invoices', i, invoices.length);
    }
  }

  // ==========================================================================
  // 4) purchase_orders — 1 adjunto por OC
  // ==========================================================================
  {
    logger.table('purchase_orders', 'Sincronizando adjuntos de OC a GCS');
    const v1Rows = await v1Pool.query(`SELECT id, file_path FROM toniclife.t_supplier_requests`);
    const v1Map = new Map(v1Rows.rows.map(r => [String(r.id), r.file_path]));

    const { rows: pos } = await v2Pool.query(
      `SELECT id, legacy_id FROM tonic.purchase_orders WHERE legacy_id IS NOT NULL`
    );
    logger.info(`    ${pos.length} órdenes de compra a revisar`);

    for (const po of pos) {
      const rawPath = v1Map.get(String(po.legacy_id));
      if (rawPath && String(rawPath).trim() !== '') {
        try {
          const folder = `purchase-orders/${po.legacy_id}`;
          const res = await replaceFileSingle(rawPath, folder, 'document');
          if (res) {
            await updateColumn('tonic.purchase_orders', 'file_url', po.id, gcsUrl(res));
            results.migrated++;
          } else {
            results.skipped++;
          }
        } catch (err) {
          results.failed++;
          if (results.errors.length < 200) {
            results.errors.push({ table: 'purchase_orders', id: po.id, error: err.message });
          }
        }
      }
    }
  }

  // ==========================================================================
  // 5) system_files — 1 archivo por registro
  // ==========================================================================
  {
    logger.table('system_files', 'Sincronizando archivos de sistema a GCS');
    const v1Rows = await v1Pool.query(`SELECT id_file, url_file, path_file FROM toniclife.t_file`);
    const v1Map = new Map(v1Rows.rows.map(r => [String(r.id_file), r.url_file || r.path_file]));

    const { rows: files } = await v2Pool.query(
      `SELECT id, legacy_id FROM tonic.system_files WHERE legacy_id IS NOT NULL`
    );
    logger.info(`    ${files.length} archivos de sistema a revisar`);

    for (const f of files) {
      const rawPath = v1Map.get(String(f.legacy_id));
      if (rawPath && String(rawPath).trim() !== '') {
        try {
          const folder = `system-files/${f.legacy_id}`;
          const res = await replaceFileSingle(rawPath, folder, 'file');
          if (res) {
            await updateColumn('tonic.system_files', 'url', f.id, gcsUrl(res));
            results.migrated++;
          } else {
            results.skipped++;
          }
        } catch (err) {
          results.failed++;
          if (results.errors.length < 200) {
            results.errors.push({ table: 'system_files', id: f.id, error: err.message });
          }
        }
      }
    }
  }

  const gcsStats = gcsUploader.getStats();
  logger.info(`\n  Fase 14 completa: ${results.migrated} actualizados, ${results.skipped} omitidos, ${results.failed} fallidos`);
  logger.info(`  GCS stats: ${gcsStats.uploaded} subidos, ${gcsStats.alreadyExisted} ya existían, ${gcsStats.failed} fallidos`);

  return results;
};
