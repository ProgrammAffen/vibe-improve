import { LicenseError } from './service.mjs';

export function cloudRepository(db) {
  if (typeof db?.runTransaction !== 'function') throw new LicenseError('DATABASE_UNSUPPORTED');
  return {
    transaction(fn) {
      return db.runTransaction(async transaction => fn({
        async get(collection, id) {
          const result = await transaction.collection(collection).doc(id).get();
          if (result?.code) throw new LicenseError('DATABASE_UNAVAILABLE', true);
          const data = result?.data;
          if (Array.isArray(data)) {
            if (data.length > 1) throw new LicenseError('DATA_INTEGRITY_ERROR');
            return data[0] ? withoutId(data[0]) : null;
          }
          if (data && typeof data === 'object') return withoutId(data);
          if (data === null) return null;
          throw new LicenseError('DATA_INTEGRITY_ERROR');
        },
        async put(collection, id, value) {
          const result = await transaction.collection(collection).doc(id).set(value);
          if (result?.code) throw new LicenseError('DATABASE_UNAVAILABLE', true);
        },
      }));
    },
  };
}
function withoutId(data) { const { _id, ...rest } = data; return rest; }
