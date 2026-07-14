import Java from 'frida-java-bridge';

const NETWORK_PARAMS = 'com.bytedance.frameworks.baselib.network.http.NetworkParams';
const META_F3 = 'ms.bd.c.f3';
let tracedSecurityFactor = null;
const tracedMethods = [];
const streamContexts = new Map();
const hookedStreamClasses = new Set();
const connectionHeaders = new Map();
const responseStreamContexts = new Map();
const hookedInputStreamClasses = new Set();

function isCommerceTarget(url) {
  return /\/(?:aweme\/v2\/shop\/promotion\/pack|ecom\/product\/detail)\/|\/api\/anchor\/shop\/widget_data|\/bff\/product\/infos|\/ecom\/repurchase\/v1\/(?:follow|purchased)\/shoplist|ec_shop\/goods\/list|goods\/(?:store|shop)|\/(?:ecom\/shop|aweme\/v[23]\/shop|shop|store|window)/i.test(String(url || ''));
}

function withJava(fn) {
  return new Promise((resolve, reject) => {
    Java.perform(() => {
      try {
        resolve(fn());
      } catch (error) {
        reject(new Error(String(error && error.stack ? error.stack : error)));
      }
    });
  });
}

function getProvider(NetworkParams) {
  const field = NetworkParams.class.getDeclaredField('LJIILLIIL');
  field.setAccessible(true);
  return field.get(null);
}

function mapToObject(map) {
  if (map === null) return null;
  const MapClass = Java.use('java.util.Map');
  const typedMap = Java.cast(map, MapClass);
  const EntryClass = Java.use('java.util.Map$Entry');
  const output = {};
  const iterator = typedMap.entrySet().iterator();
  while (iterator.hasNext()) {
    const entry = Java.cast(iterator.next(), EntryClass);
    output[String(entry.getKey())] = String(entry.getValue());
  }
  return output;
}

function buildHeaderMap(headers) {
  const HashMap = Java.use('java.util.HashMap');
  const ArrayList = Java.use('java.util.ArrayList');
  const map = HashMap.$new();

  Object.keys(headers || {}).forEach((name) => {
    const values = ArrayList.$new();
    const value = headers[name];
    if (Array.isArray(value)) {
      value.forEach((item) => values.add(String(item)));
    } else if (value !== null && value !== undefined) {
      values.add(String(value));
    }
    map.put(String(name), values);
  });
  return map;
}

function snapshotConnection(connection) {
  const snapshot = { url: null, method: null, headers: null };
  let connectionId = null;
  try {
    const System = Java.use('java.lang.System');
    connectionId = String(System.identityHashCode(connection));
    snapshot.connectionId = connectionId;
  } catch (_) {}
  try { snapshot.url = String(connection.getURL().toString()); } catch (_) {}
  try { snapshot.method = String(connection.getRequestMethod()); } catch (_) {}
  if (connectionId !== null && connectionHeaders.has(connectionId)) {
    snapshot.headers = connectionHeaders.get(connectionId);
  }
  try {
    const properties = connection.getRequestProperties();
    if (properties !== null) {
      const MapClass = Java.use('java.util.Map');
      const EntryClass = Java.use('java.util.Map$Entry');
      const map = Java.cast(properties, MapClass);
      const iterator = map.entrySet().iterator();
      const headers = {};
      while (iterator.hasNext()) {
        const entry = Java.cast(iterator.next(), EntryClass);
        headers[String(entry.getKey())] = String(entry.getValue());
      }
      snapshot.headers = { ...(snapshot.headers || {}), ...headers };
    }
  } catch (error) {
    snapshot.headerError = String(error);
  }
  return snapshot;
}

function rememberConnectionHeader(connection, name, value, append) {
  try {
    const System = Java.use('java.lang.System');
    const connectionId = String(System.identityHashCode(connection));
    const headers = connectionHeaders.get(connectionId) || {};
    const key = String(name);
    const textValue = String(value);
    if (append && Object.prototype.hasOwnProperty.call(headers, key)) {
      headers[key] = `${headers[key]}, ${textValue}`;
    } else {
      headers[key] = textValue;
    }
    connectionHeaders.set(connectionId, headers);
  } catch (_) {}
}

function byteRangeToBase64(buffer, offset, length) {
  const Base64 = Java.use('android.util.Base64');
  const values = [];
  for (let i = 0; i < length; i++) values.push(buffer[offset + i]);
  return String(Base64.encodeToString(Java.array('byte', values), 2));
}

function installOutputStreamHook(className) {
  if (hookedStreamClasses.has(className)) return;
  hookedStreamClasses.add(className);

  try {
    const System = Java.use('java.lang.System');
    const Stream = Java.use(className);
    const write = Stream.write.overload('[B', 'int', 'int');
    write.implementation = function (buffer, offset, length) {
      const streamId = String(System.identityHashCode(this));
      const context = streamContexts.get(streamId);
      if (context && isCommerceTarget(context.url) && length > 0) {
        try {
          send({
            event: 'request-body-chunk',
            streamId,
            streamClass: className,
            url: context.url,
            offset: Number(offset),
            length: Number(length),
            base64: byteRangeToBase64(buffer, Number(offset), Number(length)),
          });
        } catch (error) {
          send({ event: 'request-body-error', streamId, url: context.url, error: String(error) });
        }
      }
      return write.call(this, buffer, offset, length);
    };
    tracedMethods.push(write);
    send({ event: 'output-stream-hooked', streamClass: className });
  } catch (error) {
    send({ event: 'trace-install-error', target: className + '.write([B,int,int)', error: String(error) });
  }
}

function snapshotResponse(connection) {
  const snapshot = snapshotConnection(connection);
  try { snapshot.responseCode = Number(connection.getResponseCode()); } catch (_) {}
  try {
    const fields = connection.getHeaderFields();
    if (fields !== null) snapshot.responseHeaders = mapToObject(fields);
  } catch (error) {
    snapshot.responseHeaderError = String(error);
  }
  return snapshot;
}

function installInputStreamHook(className) {
  if (hookedInputStreamClasses.has(className)) return;
  hookedInputStreamClasses.add(className);

  try {
    const System = Java.use('java.lang.System');
    const Stream = Java.use(className);
    function emitChunk(stream, buffer, offset, count) {
      const streamId = String(System.identityHashCode(stream));
      const context = responseStreamContexts.get(streamId);
      if (context && isCommerceTarget(context.url) && count > 0) {
        try {
          send({
            event: 'response-body-chunk',
            streamId,
            streamClass: className,
            url: context.url,
            offset: Number(offset),
            length: Number(count),
            base64: byteRangeToBase64(buffer, Number(offset), Number(count)),
          });
        } catch (error) {
          send({ event: 'response-body-error', streamId, url: context.url, error: String(error) });
        }
      }
    }

    const read = Stream.read.overload('[B', 'int', 'int');
    read.implementation = function (buffer, offset, length) {
      const count = read.call(this, buffer, offset, length);
      emitChunk(this, buffer, offset, count);
      return count;
    };
    tracedMethods.push(read);

    try {
      const readBuffer = Stream.read.overload('[B');
      readBuffer.implementation = function (buffer) {
        const count = readBuffer.call(this, buffer);
        emitChunk(this, buffer, 0, count);
        return count;
      };
      tracedMethods.push(readBuffer);
    } catch (_) {}

    try {
      const readByte = Stream.read.overload();
      readByte.implementation = function () {
        const value = readByte.call(this);
        const streamId = String(System.identityHashCode(this));
        const context = responseStreamContexts.get(streamId);
        if (context && isCommerceTarget(context.url) && value >= 0) {
          const Byte = Java.use('java.lang.Byte');
          const signed = value > 127 ? value - 256 : value;
          send({
            event: 'response-body-chunk',
            streamId,
            streamClass: className,
            url: context.url,
            offset: 0,
            length: 1,
            base64: byteRangeToBase64(Java.array('byte', [signed]), 0, 1),
          });
        }
        return value;
      };
      tracedMethods.push(readByte);
    } catch (_) {}

    send({ event: 'input-stream-hooked', streamClass: className });
  } catch (error) {
    send({ event: 'trace-install-error', target: className + '.read([B,int,int)', error: String(error) });
  }
}

rpc.exports = {
  ping() {
    return { pid: Process.id, arch: Process.arch };
  },

  status() {
    return withJava(() => {
      const NetworkParams = Java.use(NETWORK_PARAMS);
      const provider = getProvider(NetworkParams);
      let f3Loaded = false;
      try {
        Java.use(META_F3);
        f3Loaded = true;
      } catch (_) {}
      return {
        javaAvailable: Java.available,
        networkParamsLoaded: true,
        providerInstalled: provider !== null,
        providerClass: provider === null ? null : String(provider.getClass().getName()),
        f3Loaded,
      };
    });
  },

  sign(url, headers) {
    return withJava(() => {
      const NetworkParams = Java.use(NETWORK_PARAMS);
      const provider = getProvider(NetworkParams);
      if (provider === null) {
        throw new Error('MetaSec provider is not installed yet');
      }
      const method = NetworkParams.LJIILLIIL.overload('java.lang.String', 'java.util.Map');
      const result = method.call(NetworkParams, String(url), buildHeaderMap(headers || {}));
      return mapToObject(result);
    });
  },

  starttrace() {
    return withJava(() => {
      if (tracedSecurityFactor !== null) return { installed: true, reused: true };
      Java.deoptimizeEverything();
      const NetworkParams = Java.use(NETWORK_PARAMS);
      const method = NetworkParams.LJIILLIIL.overload('java.lang.String', 'java.util.Map');
      tracedSecurityFactor = method;
      method.implementation = function (url, headers) {
        const startedAt = Date.now();
        const result = method.call(NetworkParams, url, headers);
        let output = null;
        try { output = mapToObject(result); } catch (error) { output = { _decodeError: String(error) }; }
        send({
          event: 'security-factor',
          url: String(url),
          output,
          elapsedMs: Date.now() - startedAt,
        });
        return result;
      };

      try {
        const Adapter = Java.use('com.bytedance.ttnet.cronet.AbsCronetDependAdapter');
        const callback = Adapter.onCallToAddSecurityFactor.overload('java.lang.String', 'java.util.Map');
        callback.implementation = function (url, headers) {
          const result = callback.call(this, url, headers);
          send({ event: 'cronet-security-factor', url: String(url), output: mapToObject(result) });
          return result;
        };
        tracedMethods.push(callback);
      } catch (error) {
        send({ event: 'trace-install-error', target: 'AbsCronetDependAdapter', error: String(error) });
      }

      try {
        const F3 = Java.use(META_F3);
        const nativeCall = F3.a.overload('int', 'int', 'long', 'java.lang.String', 'java.lang.Object');
        nativeCall.implementation = function (op, arg, handle, text, payload) {
          const result = nativeCall.call(F3, op, arg, handle, text, payload);
          if (op === 50331649 || op === 100663297) {
            const values = [];
            if (result !== null) {
              try {
                const ReflectArray = Java.use('java.lang.reflect.Array');
                const length = ReflectArray.getLength(result);
                for (let i = 0; i < length; i++) values.push(String(ReflectArray.get(result, i)));
              } catch (error) {
                values.push('_decodeError=' + String(error));
              }
            }
            send({
              event: 'f3-sign', op, arg, handle: String(handle),
              text: text === null ? null : String(text), values,
            });
          }
          return result;
        };
        tracedMethods.push(nativeCall);
      } catch (error) {
        send({ event: 'trace-install-error', target: 'f3.a', error: String(error) });
      }

      try {
        const Builder = Java.use('okhttp3.Request$Builder');
        const addHeader = Builder.addHeader.overload('java.lang.String', 'java.lang.String');
        addHeader.implementation = function (name, value) {
          if (/^(x-|pigeon)/i.test(String(name))) {
            send({ event: 'request-header', stack: 'okhttp3', name: String(name), value: String(value) });
          }
          return addHeader.call(this, name, value);
        };
        tracedMethods.push(addHeader);
      } catch (error) {
        send({ event: 'trace-install-error', target: 'okhttp3.Request$Builder.addHeader', error: String(error) });
      }

      try {
        const Connection = Java.use('com.ttnet.org.chromium.net.urlconnection.CronetHttpURLConnection');
        const setRequestProperty = Connection.setRequestProperty.overload('java.lang.String', 'java.lang.String');
        setRequestProperty.implementation = function (name, value) {
          rememberConnectionHeader(this, name, value, false);
          return setRequestProperty.call(this, name, value);
        };
        tracedMethods.push(setRequestProperty);

        const addRequestProperty = Connection.addRequestProperty.overload('java.lang.String', 'java.lang.String');
        addRequestProperty.implementation = function (name, value) {
          rememberConnectionHeader(this, name, value, true);
          return addRequestProperty.call(this, name, value);
        };
        tracedMethods.push(addRequestProperty);

        const connect = Connection.connect.overload();
        connect.implementation = function () {
          send({ event: 'connection-final', trigger: 'connect', ...snapshotConnection(this) });
          return connect.call(this);
        };
        tracedMethods.push(connect);

        const getOutputStream = Connection.getOutputStream.overload();
        getOutputStream.implementation = function () {
          const stream = getOutputStream.call(this);
          const System = Java.use('java.lang.System');
          const snapshot = snapshotConnection(this);
          const streamId = String(System.identityHashCode(stream));
          const streamClass = String(stream.getClass().getName());
          streamContexts.set(streamId, snapshot);
          installOutputStreamHook(streamClass);
          send({
            event: 'connection-final', trigger: 'getOutputStream',
            streamId, streamClass, ...snapshot,
          });
          return stream;
        };
        tracedMethods.push(getOutputStream);

        const getInputStream = Connection.getInputStream.overload();
        getInputStream.implementation = function () {
          const stream = getInputStream.call(this);
          const System = Java.use('java.lang.System');
          const snapshot = snapshotResponse(this);
          const streamId = String(System.identityHashCode(stream));
          const streamClass = String(stream.getClass().getName());
          responseStreamContexts.set(streamId, snapshot);
          installInputStreamHook(streamClass);
          send({
            event: 'response-stream',
            trigger: 'getInputStream',
            streamId, streamClass, ...snapshot,
          });
          return stream;
        };
        tracedMethods.push(getInputStream);

        const getErrorStream = Connection.getErrorStream.overload();
        getErrorStream.implementation = function () {
          const stream = getErrorStream.call(this);
          if (stream !== null) {
            const System = Java.use('java.lang.System');
            const snapshot = snapshotResponse(this);
            const streamId = String(System.identityHashCode(stream));
            const streamClass = String(stream.getClass().getName());
            responseStreamContexts.set(streamId, snapshot);
            installInputStreamHook(streamClass);
            send({
              event: 'response-stream',
              trigger: 'getErrorStream',
              streamId, streamClass, ...snapshot,
            });
          }
          return stream;
        };
        tracedMethods.push(getErrorStream);
      } catch (error) {
        send({ event: 'trace-install-error', target: 'CronetHttpURLConnection', error: String(error) });
      }

      return { installed: true, reused: false, extraHooks: tracedMethods.length };
    });
  },

  stoptrace() {
    return withJava(() => {
      if (tracedSecurityFactor !== null) tracedSecurityFactor.implementation = null;
      tracedSecurityFactor = null;
      while (tracedMethods.length > 0) tracedMethods.pop().implementation = null;
      streamContexts.clear();
      hookedStreamClasses.clear();
      connectionHeaders.clear();
      responseStreamContexts.clear();
      hookedInputStreamClasses.clear();
      return { installed: false };
    });
  },
};
