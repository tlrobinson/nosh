#!/usr/bin/env node

const repl = require("repl");
const fs = require("fs");
const child_process = require("child_process");
const path = require("path");
const readline = require("readline");
const vm = require("vm");
const requireLike = require("require-like");

const { Stream, PassThrough, Readable, Writable } = require("stream");

const HISTORY_PATH = ".noshhistory";

const paths = process.env.PATH.split(":");

global.cd = async path => process.chdir(path);

class Process {
  constructor(executablePath, args) {
    // we need these streams because the actual process may not start until all the arguments are resolved
    const stdin = AsymmetricalStreamPair({ allowHalfOpen: false });
    const stdout = AsymmetricalStreamPair({ allowHalfOpen: false });
    const stderr = AsymmetricalStreamPair({ allowHalfOpen: false });

    this.stdin = stdin.writable;
    this.stdout = stdout.readable;
    this.stderr = stderr.readable;

    let piped = false;
    this.stdin.on("pipe", () => (piped = true));

    this.promise = new Promise(async (resolve, reject) => {
      const streams = [stdin.readable, stdout.writable, stderr.writable];

      // resolve the arguments if needed
      const finalArgs = await Promise.all(
        args.map(arg => {
          if (arg instanceof Process) {
            return arg.string();
          } else if (arg instanceof Stream) {
            streams.push(arg);
            return `/dev/fd/${streams.length - 1}`;
          } else {
            return arg;
          }
        })
      );

      // start the process
      const proc = child_process.spawn(executablePath, finalArgs, {
        stdio: streams.map(s => "pipe")
      });

      // pipe to/from the streams
      for (const [fd, stream] of streams.entries()) {
        // TODO: better way of detecting readable/writable
        if (stream instanceof Readable) {
          stream.pipe(proc.stdio[fd]);
        }
        if (stream instanceof Writable) {
          proc.stdio[fd].pipe(stream);
        }
      }

      // wait for the process to exit and resolve or reject
      proc.on("close", code => {
        if (code === 0) {
          resolve();
        } else {
          reject(code);
        }
      });

      // automatically pipe stdin/stdout/stderr if they haven't already
      process.nextTick(() => {
        if (!piped) {
          process.stdin.pipe(this.stdin);
          // FIXME: unpipe?
        }
        if (this.stdout._readableState.paused) {
          this.stdout.pipe(process.stdout);
          proc.on("close", () => {
            this.stdout.unpipe(process.stdout);
          });
        }
        if (this.stderr._readableState.paused) {
          this.stderr.pipe(process.stderr);
          proc.on("close", () => {
            this.stderr.unpipe(process.stderr);
          });
        }
      });
    });

    // set up the bin proxy
    return binProxy(this, this);
  }
  then(...args) {
    return this.promise.then(...args);
  }
  catch(...args) {
    return this.promise.catch(...args);
  }
  lines() {
    return new Promise((resolve, reject) => {
      const lines = [];
      var lineReader = readline.createInterface({
        input: this.stdout
      });
      lineReader.on("line", line => lines.push(line));
      lineReader.on("close", () => resolve(lines));
    });
  }
  string() {
    return this.lines().then(lines => lines.join("\n"));
  }
  code() {
    return this.promise.then(code => 0, code => code);
  }
}

// TODO: backpressure?
function AsymmetricalStreamPair(options = {}) {
  let readableCallback;

  const readable = new Readable(options);
  readable._read = function _read() {
    if (!readableCallback) {
      return;
    }
    let callback = readableCallback;
    readableCallback = null;
    callback();
  };

  const writable = new Writable(options);
  writable._write = function _write(chunk, enc, callback) {
    if (readableCallback) {
      throw new Error();
    }
    if (typeof callback === "function") {
      readableCallback = callback;
    }
    readable.push(chunk);
  };

  writable._final = function _final(callback) {
    readable.on("end", callback);
    readable.push(null);
  };

  return { readable, writable };
}

function findExecutableOnPath(command) {
  if (command.match(/^[.\/]/)) {
    if (isExecutable(command)) {
      return command;
    }
  } else {
    for (const binPath of paths) {
      const fullPath = path.resolve(binPath, command);
      if (isExecutable(fullPath)) {
        return fullPath;
      }
    }
  }
}

function isExecutable(path) {
  try {
    fs.accessSync(path, fs.constants.X_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function functionForExecutable(executablePath, prevProc) {
  return function(...args) {
    const proc = new Process(executablePath, args, prevProc);
    if (prevProc) {
      prevProc.stdout.pipe(proc.stdin);
    }
    return proc;
  };
}

// returns a Proxy for `object` that will return functions for executables on your PATH
function binProxy(object, prevProc) {
  return new Proxy(object, {
    has(target, prop, receiver) {
      return prop in target || !!findExecutableOnPath(prop);
    },
    get(target, prop, receiver) {
      if (prop in target || typeof prop !== "string") {
        return target[prop];
      } else {
        const executablePath = findExecutableOnPath(prop);
        if (executablePath) {
          return functionForExecutable(executablePath, prevProc);
        }
      }
    }
  });
}

function runRepl() {
  const r = repl.start({ propt: "> " });

  if (r.historyPath && HISTORY_PATH) {
    r.historyPath(HISTORY_PATH);
  }

  // replace `context` with version with the "bin proxy" version
  r.context = vm.createContext(binProxy(global));

  r.context.require = require;
  r.context.module = module;

  // wrap `eval` with our own logic
  const _eval = r.eval;
  r.eval = function(cmd, context, filename, callback) {
    _eval(cmd, context, filename, function(err, result) {
      if (err) {
        callback(err);
      } else {
        if (result && typeof result.then === "function") {
          Promise.resolve(result)
            .then(finalResult => {
              if (finalResult === undefined) {
                callback();
              } else {
                callback(null, finalResult);
              }
            })
            .catch(finalError => callback(finalError));
        } else {
          return callback(null, result);
        }
      }
    });
  };
}

function runScript(file) {
  const context = vm.createContext(binProxy(global));

  context.require = requireLike(file);
  context.module = module;

  const code = fs.readFileSync(file, "utf-8");

  vm.runInContext(code, context);
}

exports.main = function(args) {
  if (args.length > 2) {
    runScript(args[2]);
  } else {
    runRepl();
  }
};

if (require.main === module) {
  exports.main(process.argv);
}
