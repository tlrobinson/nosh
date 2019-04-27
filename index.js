#!/usr/bin/env node

const repl = require("repl");
const fs = require("fs");
const child_process = require("child_process");
const path = require("path");
const readline = require("readline");
const vm = require("vm");

const { PassThrough } = require("stream");

const paths = process.env.PATH.split(":");

class Process {
  constructor(executablePath, args) {
    // we need these passthrough streams because the actual process may not start until all the arguments are resolved
    this.stdin = new PassThrough({ allowHalfOpen: false });
    this.stdout = new PassThrough({ allowHalfOpen: false });
    this.stderr = new PassThrough({ allowHalfOpen: false });

    this.promise = new Promise(async (resolve, reject) => {
      // resolve the arguments if needed
      const finalArgs = await Promise.all(
        args.map(arg => (arg instanceof Process ? arg.string() : arg))
      );

      // start the process
      const proc = child_process.spawn(executablePath, finalArgs);

      // pipe to/from the passthrough streams
      this.stdin.pipe(proc.stdin);
      proc.stdout.pipe(this.stdout);
      proc.stderr.pipe(this.stderr);

      // wait for the process to exit and resolve or reject
      proc.on("close", code => {
        if (code === 0) {
          resolve();
        } else {
          reject(code);
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

exports.main = function(args) {
  const r = repl.start({ propt: "> " });

  // replace `context` with version with the "bin proxy" version
  r.context = vm.createContext(binProxy(global));

  // wrap `eval` with our own logic
  const _eval = r.eval;
  r.eval = function(cmd, context, filename, callback) {
    _eval(cmd, context, filename, function(err, r) {
      if (err) {
        callback(err);
      } else {
        if (r && r.stdout && typeof r.stdout.pipe === "function") {
          r.stdout.pipe(process.stdout);
        }
        if (r && r.stderr && typeof r.stderr.pipe === "function") {
          r.stderr.pipe(process.stderr);
        }
        if (r && typeof r.then === "function") {
          Promise.resolve(r)
            .then(finalResult => {
              if (finalResult === undefined) {
                callback();
              } else {
                callback(null, finalResult);
              }
            })
            .catch(finalError => callback(finalError));
        } else {
          return callback(null, r);
        }
      }
    });
  };
};

if (require.main === module) {
  exports.main(process.argv);
}
