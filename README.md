## nosh: an experimental shell based on Node.js

`nosh` is basically a normal Node.js REPL, except any function not already defined in the REPL context can be used to run an executable that's on your PATH:

    > ls()
    README.md
    bin
    node_modules
    package.json
    yarn.lock
    undefined

The function takes optional arguments that are passed along:

    > echo("hello world")
    hello world

By default the function will print `stdout` and `stderr` and return an object that acts like a `Promise` (resolves or rejects when the command finishes). The REPL understands promises, and waits for it to resolve before printing the result and allowing the user to continue entering commands.

The returned object also has other useful functionality you can chain.

You can chain other commands, in which case stdout of the process is piped to stdin of the next process, like the `|` operator in most shells:

    > echo("hello world").cat()
    hello world

This works for any length pipeline, of course:

    > echo("hello world").cat().cat().cat().wc()
        1       2      12

You can call `.lines()` to get a promise that resolves to an array of lines:

    > ls().lines()
    [ 'README.md', 'bin', 'node_modules', 'package.json', 'yarn.lock' ]

Or `.string()` to get the output as a single string:

    > ls().string()
    'README.md\nbin\nnode_modules\npackage.json\nyarn.lock'

Non-zero exit codes will cause the promise to reject:

    > sh("-c", "false")
    Thrown: 1

You can instead call `.code()` to not reject, but instead return a promise that resolves to the exit code:

    > sh("-c", "false").code()
    1

"Command substitution" works, so you can pass any command as an argument to another command:

    > echo(echo("hello world"))
    hello world

(This is equivalent to `echo(await echo("hello world").string())`)

"Process substition" also works, so you can pass the output of a command as a file to another command:

    > cat(echo("hello world").stdout)
    hello world
    > echo(echo("hello").stdout)
    /dev/fd/3

In fact, any Stream works:

    > cat(require("net").connect(23, towel.blinkenlights.nl))

### TODO

- Observables?
- Support "set -e", "set -o pipefail", and various other shell behaviors
- Support `await`
- Support expressions other than statements
- Inject the Proxy in the context using something besides `with() { }`?
- Support various other helper methods on `Process`.
- Alternative syntaxes (`sh\`echo hello\``)
- Use as scripting language in addition to REPL?
- History
- Pick a name that's available in NPM
