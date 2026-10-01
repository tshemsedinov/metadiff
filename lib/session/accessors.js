'use strict';

const bindAccessors = (target, owner, names) => {
  for (const name of names) {
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get: () => owner[name],
      set: (value) => {
        owner[name] = value;
      },
    });
  }
};

const bindGetters = (target, owner, names) => {
  for (const name of names) {
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get: () => owner[name],
    });
  }
};

module.exports = { bindAccessors, bindGetters };
