#!/usr/bin/env node

const repl = require("repl");
const fs = require("fs");
const child_process = require("child_process");
const path = require("path");
const readline = require("readline");
const vm = require("vm");

const paths = process.env.PATH.split(":");

class Process {
  constructor(proc) {
    Object.assign(this, proc);

    this.process = proc;
    this.promise = new Promise((resolve, reject) => {
      proc.on("close", code => {
        if (code === 0) {
          resolve();
        } else {
          reject(code);
        }
      });
    });

    return binProxy(this, proc);
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
        input: this.process.stdout
      });
      lineReader.on("line", line => lines.push(line));
      lineReader.on("close", () => resolve(lines));
    });
  }
  string() {
    return this.lines().then(lines => lines.join("\n"));
  }
  code() {
    this.promise.catch(() => {}); // avoid unhandled rejection warnings if we're checking the code anyway
    return new Promise((resolve, reject) => {
      this.process.on("close", resolve);
    });
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
    let p;
    // if (Array.isArray(args[0])) {
    //   const [cmdStrs, ...cmdArgs] = args;
    //   let arg = "";
    //   for (let i = 0; i < cmdStrs.length; i++) {
    //     arg += cmdStrs[i];
    //     if (i < cmdArgs.length) {
    //       arg += cmdArgs[i];
    //     }
    //   }
    //   p = child_process.spawn(executablePath, [arg]);
    // } else {
    p = child_process.spawn(executablePath, args);
    // }
    if (prevProc) {
      prevProc.stdout.pipe(p.stdin);
    }
    return new Process(p);
  };
}

// returns a Proxy for `object` that will return functions for executables on your PATH
function binProxy(object, parent) {
  return new Proxy(
    {},
    {
      has(target, prop, receiver) {
        return true;
      },
      get(target, prop, receiver) {
        if (prop in object || typeof prop !== "string") {
          return object[prop];
        } else {
          const executablePath = findExecutableOnPath(prop);
          if (executablePath) {
            return functionForExecutable(executablePath, parent);
          }
        }
      }
    }
  );
}

exports.main = function(args) {
  const r = repl.start({ propt: "> " });

  // replace context with version with the "bin proxy" version
  r.context = vm.createContext(binProxy(global));

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
