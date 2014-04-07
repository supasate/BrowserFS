import buffer = require('../core/buffer');
import browserfs = require('../core/browserfs');
import kvfs = require('../generic/key_value_filesystem');
import api_error = require('../core/api_error');
import buffer_core_arraybuffer = require('../core/buffer_core_arraybuffer');
import global = require('../core/global');
import cache = require('../adaptors/cache');
var Buffer = buffer.Buffer,
  ApiError = api_error.ApiError,
  ErrorCode = api_error.ErrorCode,
  /**
   * Get the indexedDB constructor for the current browser.
   */
  indexedDB: IDBFactory = global.indexedDB ||
                          (<any>global).mozIndexedDB ||
                          (<any>global).webkitIndexedDB ||
                          global.msIndexedDB;

/**
 * Converts a DOMException or a DOMError from an IndexedDB event into a
 * standardized BrowserFS API error.
 */
function convertError(e: {name: string}, message: string = e.toString()): api_error.ApiError {
  switch(e.name) {
    case "NotFoundError":
      return new ApiError(ErrorCode.ENOENT, message);
    case "QuotaExceededError":
      return new ApiError(ErrorCode.ENOSPC, message);
    default:
      // The rest do not seem to map cleanly to standard error codes.
      return new ApiError(ErrorCode.EIO, message);
  }
}

/**
 * Produces a new onerror handler for IDB. Our errors are always fatal, so we
 * handle them generically: Call the user-supplied callback with a translated
 * version of the error, and let the error bubble up.
 */
function onErrorHandler(cb: (e: api_error.ApiError) => void,
  code: api_error.ErrorCode = ErrorCode.EIO, message: string = null): (e?: any) => void {
  return function (e?: any): void {
    // Prevent the error from canceling the transaction.
    e.preventDefault();
    cb(new ApiError(code, message));
  };
}

/**
 * Converts a NodeBuffer into an ArrayBuffer.
 */
function buffer2arraybuffer(data: NodeBuffer): ArrayBuffer {
  // XXX: Typing hack.
  var backing_mem: buffer_core_arraybuffer.BufferCoreArrayBuffer = <buffer_core_arraybuffer.BufferCoreArrayBuffer><any> (<buffer.BFSBuffer><any>data).getBufferCore();
  if (!(backing_mem instanceof buffer_core_arraybuffer.BufferCoreArrayBuffer)) {
    // Copy into an ArrayBuffer-backed Buffer.
    buffer = new Buffer(this._buffer.length);
    this._buffer.copy(buffer);
    backing_mem = <buffer_core_arraybuffer.BufferCoreArrayBuffer><any> (<buffer.BFSBuffer><any>buffer).getBufferCore();
  }
  // Reach into the BC, grab the DV.
  var dv = backing_mem.getDataView();
  return dv.buffer;
}

export class IndexedDBROTransaction implements kvfs.AsyncKeyValueROTransaction {
  constructor(public tx: IDBTransaction, public store: IDBObjectStore,
    public cache: cache.SyncCache) { }

  get(key: string, cb: (e: api_error.ApiError, data?: NodeBuffer) => void): void {
    try {
      var cache_data: NodeBuffer = this.cache.get(key);
      if (cache_data != null) cb(null, cache_data);

      var r: IDBRequest = this.store.get(key);
      r.onerror = onErrorHandler(cb);
      r.onsuccess = (event) => {
        // IDB returns the value 'undefined' when you try to get keys that
        // don't exist. The caller expects this behavior.
        var result: any = (<any>event.target).result;
        if (result === undefined) {
          cb(null, result);
        } else {
          // IDB data is stored as an ArrayBuffer
          cache_data = new Buffer(result);
          this.cache.put(key, cache_data);
          cb(null, cache_data);
        }
      };
    } catch (e) {
      cb(convertError(e));
    }
  }
}

export class IndexedDBRWTransaction extends IndexedDBROTransaction implements kvfs.AsyncKeyValueRWTransaction, kvfs.AsyncKeyValueROTransaction {
  constructor(tx: IDBTransaction, store: IDBObjectStore, cache: cache.SyncCache) {
    super(tx, store, cache);
  }

  public put(key: string, data: NodeBuffer, overwrite: boolean, cb: (e: api_error.ApiError, committed?: boolean) => void): void {
    try {
      var arraybuffer = buffer2arraybuffer(data),
        r: IDBRequest;
      if (overwrite) {
        r = this.store.put(arraybuffer, key);
      } else {
        // 'add' will never overwrite an existing key.
        r = this.store.add(arraybuffer, key);
      }
      // XXX: NEED TO RETURN FALSE WHEN ADD HAS A KEY CONFLICT. NO ERROR.
      r.onerror = onErrorHandler(cb);
      r.onsuccess = (event) => {
        this.cache.put(key, data);
        cb(null, true);
      };
    } catch (e) {
      cb(convertError(e));
    }
  }

  public delete(key: string, cb: (e?: api_error.ApiError) => void): void {
    try {
      var r: IDBRequest = this.store.delete(key);
      r.onerror = onErrorHandler(cb);
      r.onsuccess = (event) => {
        this.cache.del(key);
        cb();
      };
    } catch (e) {
      cb(convertError(e));
    }
  }

  public commit(cb: (e?: api_error.ApiError) => void): void {
    // Return to the event loop to commit the transaction.
    setTimeout(cb, 0);
  }

  public abort(cb: (e?: api_error.ApiError) => void): void {
    var _e: api_error.ApiError;
    try {
      this.tx.abort();
    } catch (e) {
      _e = convertError(e);
    } finally {
      cb(_e);
    }
  }
}

export class IndexedDBStore implements kvfs.AsyncKeyValueStore {
  private db: IDBDatabase;

  /**
   * Constructs an IndexedDB file system.
   * @param cb Called once the database is instantiated and ready for use.
   *   Passes an error if there was an issue instantiating the database.
   * @param objectStoreName The name of this file system. You can have
   *   multiple IndexedDB file systems operating at once, but each must have
   *   a different name.
   */
  constructor(cb: (e: api_error.ApiError, store?: IndexedDBStore) => void, private storeName: string = 'browserfs', private _cache: cache.SyncCache = new cache.NopSyncCache()) {
    var openReq: IDBOpenDBRequest = indexedDB.open(this.storeName, 1);

    openReq.onupgradeneeded = (event) => {
      var db: IDBDatabase = (<any>event.target).result;
      // Huh. This should never happen; we're at version 1. Why does another
      // database exist?
      if (db.objectStoreNames.contains(this.storeName)) {
        db.deleteObjectStore(this.storeName);
      }
      db.createObjectStore(this.storeName);
    };

    openReq.onsuccess = (event) => {
      this.db = (<any>event.target).result;
      cb(null, this);
    };

    openReq.onerror = onErrorHandler(cb, ErrorCode.EACCES);
  }

  public name(): string {
    return "IndexedDB - " + this.storeName;
  }

  public clear(cb: (e?: api_error.ApiError) => void): void {
    try {
      var tx = this.db.transaction(this.storeName, 'readwrite'),
        objectStore = tx.objectStore(this.storeName),
        r: IDBRequest = objectStore.clear();
      r.onsuccess = (event) => {
        // Use setTimeout to commit transaction.
        setTimeout(cb, 0);
      };
      r.onerror = onErrorHandler(cb);
    } catch (e) {
      cb(convertError(e));
    }
  }

  public beginTransaction(type: string = 'readonly'): kvfs.AsyncKeyValueROTransaction {
    var tx = this.db.transaction(this.storeName, type),
      objectStore = tx.objectStore(this.storeName);
    if (type === 'readwrite') {
      return new IndexedDBRWTransaction(tx, objectStore, this._cache);
    } else if (type === 'readonly') {
      return new IndexedDBROTransaction(tx, objectStore, this._cache);
    } else {
      throw new ApiError(ErrorCode.EINVAL, 'Invalid transaction type.');
    }
  }

  public resetCache(newCache: cache.SyncCache) {
    this._cache = newCache;
  }
}

/**
 * A file system that uses the IndexedDB key value file system.
 */
export class IndexedDBFileSystem extends kvfs.AsyncKeyValueFileSystem {
  private idbStore: IndexedDBStore;
  constructor(cb: (e: api_error.ApiError, fs?: IndexedDBFileSystem) => void, storeName?: string,
    _cache?: cache.SyncCache) {
    super();
    this.idbStore = new IndexedDBStore((e, store?): void => {
      if (e) {
        cb(e);
      } else {
        this.init(store, (e?) => {
          cb(e, this);
        });
      }
    }, storeName, _cache);
  }

  public resetCache(newCache: cache.SyncCache) {
    this.idbStore.resetCache(newCache);
  }

  public static isAvailable(): boolean {
    return typeof indexedDB !== 'undefined';
  }
}

browserfs.registerFileSystem('IndexedDB', IndexedDBFileSystem);
