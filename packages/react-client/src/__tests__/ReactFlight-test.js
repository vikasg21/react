/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment node
 */

'use strict';

let act;
let React;
let ReactNoop;
let ReactNoopFlightServer;
let ReactNoopFlightClient;
let ErrorBoundary;
let NoErrorExpected;
let Scheduler;
let ContextRegistry;

describe('ReactFlight', () => {
  beforeEach(() => {
    jest.resetModules();

    React = require('react');
    ReactNoop = require('react-noop-renderer');
    ReactNoopFlightServer = require('react-noop-renderer/flight-server');
    ReactNoopFlightClient = require('react-noop-renderer/flight-client');
    act = require('jest-react').act;
    Scheduler = require('scheduler');
    const ReactSharedInternals =
      React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
    ContextRegistry = ReactSharedInternals.ContextRegistry;

    ErrorBoundary = class extends React.Component {
      state = {hasError: false, error: null};
      static getDerivedStateFromError(error) {
        return {
          hasError: true,
          error,
        };
      }
      componentDidMount() {
        expect(this.state.hasError).toBe(true);
        expect(this.state.error).toBeTruthy();
        expect(this.state.error.message).toContain(this.props.expectedMessage);
      }
      render() {
        if (this.state.hasError) {
          return this.state.error.message;
        }
        return this.props.children;
      }
    };

    NoErrorExpected = class extends React.Component {
      state = {hasError: false, error: null};
      static getDerivedStateFromError(error) {
        return {
          hasError: true,
          error,
        };
      }
      componentDidMount() {
        expect(this.state.error).toBe(null);
        expect(this.state.hasError).toBe(false);
      }
      render() {
        if (this.state.hasError) {
          return this.state.error.message;
        }
        return this.props.children;
      }
    };
  });

  function moduleReference(value) {
    return {
      $$typeof: Symbol.for('react.module.reference'),
      value: value,
    };
  }

  it('can render a server component', () => {
    function Bar({text}) {
      return text.toUpperCase();
    }
    function Foo() {
      return {
        bar: (
          <div>
            <Bar text="a" />, <Bar text="b" />
          </div>
        ),
      };
    }
    const transport = ReactNoopFlightServer.render({
      foo: <Foo />,
    });
    const model = ReactNoopFlightClient.read(transport);
    expect(model).toEqual({
      foo: {
        bar: (
          <div>
            {'A'}
            {', '}
            {'B'}
          </div>
        ),
      },
    });
  });

  it('can render a client component using a module reference and render there', () => {
    function UserClient(props) {
      return (
        <span>
          {props.greeting}, {props.name}
        </span>
      );
    }
    const User = moduleReference(UserClient);

    function Greeting({firstName, lastName}) {
      return <User greeting="Hello" name={firstName + ' ' + lastName} />;
    }

    const model = {
      greeting: <Greeting firstName="Seb" lastName="Smith" />,
    };

    const transport = ReactNoopFlightServer.render(model);

    act(() => {
      const rootModel = ReactNoopFlightClient.read(transport);
      const greeting = rootModel.greeting;
      ReactNoop.render(greeting);
    });

    expect(ReactNoop).toMatchRenderedOutput(<span>Hello, Seb Smith</span>);
  });

  it('should error if a non-serializable value is passed to a host component', () => {
    function EventHandlerProp() {
      return (
        <div className="foo" onClick={function() {}}>
          Test
        </div>
      );
    }
    function FunctionProp() {
      return <div>{() => {}}</div>;
    }
    function SymbolProp() {
      return <div foo={Symbol('foo')} />;
    }

    const ref = React.createRef();
    function RefProp() {
      return <div ref={ref} />;
    }

    const options = {
      onError() {
        // ignore
      },
    };
    const event = ReactNoopFlightServer.render(<EventHandlerProp />, options);
    const fn = ReactNoopFlightServer.render(<FunctionProp />, options);
    const symbol = ReactNoopFlightServer.render(<SymbolProp />, options);
    const refs = ReactNoopFlightServer.render(<RefProp />, options);

    function Client({transport}) {
      return ReactNoopFlightClient.read(transport);
    }

    act(() => {
      ReactNoop.render(
        <>
          <ErrorBoundary expectedMessage="Event handlers cannot be passed to client component props.">
            <Client transport={event} />
          </ErrorBoundary>
          <ErrorBoundary expectedMessage="Functions cannot be passed directly to client components because they're not serializable.">
            <Client transport={fn} />
          </ErrorBoundary>
          <ErrorBoundary expectedMessage="Only global symbols received from Symbol.for(...) can be passed to client components.">
            <Client transport={symbol} />
          </ErrorBoundary>
          <ErrorBoundary expectedMessage="Refs cannot be used in server components, nor passed to client components.">
            <Client transport={refs} />
          </ErrorBoundary>
        </>,
      );
    });
  });

  it('should trigger the inner most error boundary inside a client component', () => {
    function ServerComponent() {
      throw new Error('This was thrown in the server component.');
    }

    function ClientComponent({children}) {
      // This should catch the error thrown by the server component, even though it has already happened.
      // We currently need to wrap it in a div because as it's set up right now, a lazy reference will
      // throw during reconciliation which will trigger the parent of the error boundary.
      // This is similar to how these will suspend the parent if it's a direct child of a Suspense boundary.
      // That's a bug.
      return (
        <ErrorBoundary expectedMessage="This was thrown in the server component.">
          <div>{children}</div>
        </ErrorBoundary>
      );
    }

    const ClientComponentReference = moduleReference(ClientComponent);

    function Server() {
      return (
        <ClientComponentReference>
          <ServerComponent />
        </ClientComponentReference>
      );
    }

    const data = ReactNoopFlightServer.render(<Server />, {
      onError(x) {
        // ignore
      },
    });

    function Client({transport}) {
      return ReactNoopFlightClient.read(transport);
    }

    act(() => {
      ReactNoop.render(
        <NoErrorExpected>
          <Client transport={data} />
        </NoErrorExpected>,
      );
    });
  });

  it('should warn in DEV if a toJSON instance is passed to a host component', () => {
    expect(() => {
      const transport = ReactNoopFlightServer.render(
        <input value={new Date()} />,
      );
      act(() => {
        ReactNoop.render(ReactNoopFlightClient.read(transport));
      });
    }).toErrorDev(
      'Only plain objects can be passed to client components from server components. ',
      {withoutStack: true},
    );
  });

  it('should warn in DEV if a special object is passed to a host component', () => {
    expect(() => {
      const transport = ReactNoopFlightServer.render(<input value={Math} />);
      act(() => {
        ReactNoop.render(ReactNoopFlightClient.read(transport));
      });
    }).toErrorDev(
      'Only plain objects can be passed to client components from server components. ' +
        'Built-ins like Math are not supported.',
      {withoutStack: true},
    );
  });

  it('should NOT warn in DEV for key getters', () => {
    const transport = ReactNoopFlightServer.render(<div key="a" />);
    act(() => {
      ReactNoop.render(ReactNoopFlightClient.read(transport));
    });
  });

  it('should warn in DEV if an object with symbols is passed to a host component', () => {
    expect(() => {
      const transport = ReactNoopFlightServer.render(
        <input value={{[Symbol.iterator]: {}}} />,
      );
      act(() => {
        ReactNoop.render(ReactNoopFlightClient.read(transport));
      });
    }).toErrorDev(
      'Only plain objects can be passed to client components from server components. ' +
        'Objects with symbol properties like Symbol.iterator are not supported.',
      {withoutStack: true},
    );
  });

  it('should warn in DEV if a class instance is passed to a host component', () => {
    class Foo {
      method() {}
    }
    expect(() => {
      const transport = ReactNoopFlightServer.render(
        <input value={new Foo()} />,
      );
      act(() => {
        ReactNoop.render(ReactNoopFlightClient.read(transport));
      });
    }).toErrorDev(
      'Only plain objects can be passed to client components from server components. ',
      {withoutStack: true},
    );
  });

  describe('ServerContext', () => {
    // @gate enableServerContext
    it('supports basic createServerContext usage', () => {
      const ServerContext = React.createServerContext(
        'ServerContext',
        'hello from server',
      );
      function Foo() {
        const context = React.useContext(ServerContext);
        return <div>{context}</div>;
      }

      const transport = ReactNoopFlightServer.render(<Foo />);
      act(() => {
        ServerContext._currentRenderer = null;
        ServerContext._currentRenderer2 = null;
        ReactNoop.render(ReactNoopFlightClient.read(transport));
      });

      expect(ReactNoop).toMatchRenderedOutput(<div>hello from server</div>);
    });

    // @gate enableServerContext
    it('propagates ServerContext providers in flight', () => {
      const ServerContext = React.createServerContext(
        'ServerContext',
        'default',
      );

      function Foo() {
        return (
          <div>
            <ServerContext.Provider value="hi this is server">
              <Bar />
            </ServerContext.Provider>
          </div>
        );
      }
      function Bar() {
        const context = React.useContext(ServerContext);
        return context;
      }

      const transport = ReactNoopFlightServer.render(<Foo />);
      act(() => {
        ServerContext._currentRenderer = null;
        ServerContext._currentRenderer2 = null;
        ReactNoop.render(ReactNoopFlightClient.read(transport));
      });

      expect(ReactNoop).toMatchRenderedOutput(<div>hi this is server</div>);
    });

    // @gate enableServerContext
    it('errors if you try passing JSX through ServerContext value', () => {
      const ServerContext = React.createServerContext('ServerContext', {
        foo: {
          bar: <span>hi this is default</span>,
        },
      });

      function Foo() {
        return (
          <div>
            <ServerContext.Provider
              value={{
                foo: {
                  bar: <span>hi this is server</span>,
                },
              }}>
              <Bar />
            </ServerContext.Provider>
          </div>
        );
      }
      function Bar() {
        const context = React.useContext(ServerContext);
        return context.foo.bar;
      }

      expect(() => {
        ReactNoopFlightServer.render(<Foo />);
      }).toErrorDev('React elements are not allowed in ServerContext', {
        withoutStack: true,
      });
    });

    // @gate enableServerContext
    it('propagates ServerContext and cleansup providers in flight', () => {
      const ServerContext = React.createServerContext(
        'ServerContext',
        'default',
      );

      function Foo() {
        return (
          <>
            <ServerContext.Provider value="hi this is server outer">
              <ServerContext.Provider value="hi this is server">
                <Bar />
              </ServerContext.Provider>
              <ServerContext.Provider value="hi this is server2">
                <Bar />
              </ServerContext.Provider>
              <Bar />
            </ServerContext.Provider>
            <ServerContext.Provider value="hi this is server outer2">
              <Bar />
            </ServerContext.Provider>
            <Bar />
          </>
        );
      }
      function Bar() {
        const context = React.useContext(ServerContext);
        return <span>{context}</span>;
      }

      const transport = ReactNoopFlightServer.render(<Foo />);
      act(() => {
        ServerContext._currentRenderer = null;
        ServerContext._currentRenderer2 = null;
        ReactNoop.render(ReactNoopFlightClient.read(transport));
      });

      expect(ReactNoop).toMatchRenderedOutput(
        <>
          <span>hi this is server</span>
          <span>hi this is server2</span>
          <span>hi this is server outer</span>
          <span>hi this is server outer2</span>
          <span>default</span>
        </>,
      );
    });

    // @gate enableServerContext
    it('propagates ServerContext providers in flight after suspending', async () => {
      const ServerContext = React.createServerContext(
        'ServerContext',
        'default',
      );

      function Foo() {
        return (
          <div>
            <ServerContext.Provider value="hi this is server">
              <React.Suspense fallback={'Loading'}>
                <Bar />
              </React.Suspense>
            </ServerContext.Provider>
          </div>
        );
      }

      let resolve;
      const promise = new Promise(res => {
        resolve = () => {
          promise.unsuspend = true;
          res();
        };
      });

      function Bar() {
        if (!promise.unsuspend) {
          Scheduler.unstable_yieldValue('suspended');
          throw promise;
        }
        Scheduler.unstable_yieldValue('rendered');
        const context = React.useContext(ServerContext);
        return context;
      }

      const transport = ReactNoopFlightServer.render(<Foo />);

      expect(Scheduler).toHaveYielded(['suspended']);

      await act(async () => {
        resolve();
        await promise;
        jest.runAllImmediates();
      });

      expect(Scheduler).toHaveYielded(['rendered']);

      act(() => {
        ServerContext._currentRenderer = null;
        ServerContext._currentRenderer2 = null;
        ReactNoop.render(ReactNoopFlightClient.read(transport));
      });

      expect(ReactNoop).toMatchRenderedOutput(<div>hi this is server</div>);
    });

    // @gate enableServerContext
    it('serializes ServerContext to client', async () => {
      const ServerContext = React.createServerContext(
        'ServerContext',
        'default',
      );

      function ClientBar() {
        Scheduler.unstable_yieldValue('ClientBar');
        const context = React.useContext(ServerContext);
        return <span>{context}</span>;
      }

      const Bar = moduleReference(ClientBar);

      function Foo() {
        return (
          <ServerContext.Provider value="hi this is server">
            <Bar />
          </ServerContext.Provider>
        );
      }

      const model = {
        foo: <Foo />,
      };

      const transport = ReactNoopFlightServer.render(model);

      expect(Scheduler).toHaveYielded([]);

      act(() => {
        ServerContext._currentRenderer = null;
        ServerContext._currentRenderer2 = null;
        const flightModel = ReactNoopFlightClient.read(transport);
        ReactNoop.render(flightModel.foo);
      });

      expect(Scheduler).toHaveYielded(['ClientBar']);
      expect(ReactNoop).toMatchRenderedOutput(<span>hi this is server</span>);

      expect(() => {
        React.createServerContext('ServerContext', 'default');
      }).toThrow('ServerContext: ServerContext already defined');
    });

    // @gate enableServerContext
    it('takes ServerContext from client for refetching usecases', async () => {
      const ServerContext = React.createServerContext(
        'ServerContext',
        'default',
      );
      function Bar() {
        return <span>{React.useContext(ServerContext)}</span>;
      }
      const transport = ReactNoopFlightServer.render(<Bar />, {}, [
        ['ServerContext', 'Override'],
      ]);

      act(() => {
        const flightModel = ReactNoopFlightClient.read(transport);
        ReactNoop.render(flightModel);
      });

      expect(ReactNoop).toMatchRenderedOutput(<span>Override</span>);
    });

    // @gate enableServerContext
    it('sets default initial value when defined lazily on server or client', async () => {
      let ServerContext;
      function inlineLazyServerContextInitialization() {
        if (!ServerContext) {
          ServerContext = React.createServerContext('ServerContext', 'default');
        }
        return ServerContext;
      }

      let ClientContext;
      function inlineContextInitialization() {
        if (!ClientContext) {
          ClientContext = React.createServerContext('ServerContext', 'default');
        }
        return ClientContext;
      }

      function ClientBaz() {
        const context = inlineContextInitialization();
        const value = React.useContext(context);
        return <div>{value}</div>;
      }

      const Baz = moduleReference(ClientBaz);

      function Bar() {
        return (
          <article>
            <div>
              {React.useContext(inlineLazyServerContextInitialization())}
            </div>
            <Baz />
          </article>
        );
      }

      function ServerApp() {
        const Context = inlineLazyServerContextInitialization();
        return (
          <>
            <Context.Provider value="test">
              <Bar />
            </Context.Provider>
            <Bar />
          </>
        );
      }

      function ClientApp({serverModel}) {
        return (
          <>
            {serverModel}
            <ClientBaz />
          </>
        );
      }

      const transport = ReactNoopFlightServer.render(<ServerApp />);

      expect(ClientContext).toBe(undefined);
      act(() => {
        delete ContextRegistry.ServerContext;
        ServerContext._currentRenderer = null;
        ServerContext._currentRenderer2 = null;
        const serverModel = ReactNoopFlightClient.read(transport);
        ReactNoop.render(<ClientApp serverModel={serverModel} />);
      });

      expect(ReactNoop).toMatchRenderedOutput(
        <>
          <article>
            <div>test</div>
            <div>test</div>
          </article>
          <article>
            <div>default</div>
            <div>default</div>
          </article>
          <div>default</div>
        </>,
      );
    });
  });
});
