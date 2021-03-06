"use strict";

const _ = require(`lodash`);

const {
  getNamedType
} = require(`graphql`);

const getQueryFields = ({
  filter,
  sort,
  group,
  distinct
}) => {
  const filterFields = filter ? dropQueryOperators(filter) : {};
  const sortFields = sort && sort.fields || [];

  if (group && !Array.isArray(group)) {
    group = [group];
  } else if (group == null) {
    group = [];
  }

  if (distinct && !Array.isArray(distinct)) {
    distinct = [distinct];
  } else if (distinct == null) {
    distinct = [];
  }

  return merge(filterFields, ...sortFields.map(pathToObject), ...group.map(pathToObject), ...distinct.map(pathToObject));
};

const mergeObjects = (obj1, obj2) => Object.keys(obj2).reduce((acc, key) => {
  const value = obj2[key];

  if (typeof value === `object` && value && acc[key]) {
    acc[key] = mergeObjects(acc[key], value);
  } else {
    acc[key] = value;
  }

  return acc;
}, obj1);

const merge = (...objects) => {
  const [first, ...rest] = objects.filter(Boolean);
  return rest.reduce((acc, obj) => mergeObjects(acc, obj), { ...first
  });
};

const pathToObject = path => {
  if (path && typeof path === `string`) {
    return path.split(`.`).reduceRight((acc, key) => {
      return {
        [key]: acc
      };
    }, true);
  }

  return {};
};

const dropQueryOperators = filter => Object.keys(filter).reduce((acc, key) => {
  const value = filter[key];
  const k = Object.keys(value)[0];
  const v = value[k];

  if (_.isPlainObject(value) && _.isPlainObject(v)) {
    acc[key] = k === `elemMatch` ? dropQueryOperators(v) : dropQueryOperators(value);
  } else {
    acc[key] = true;
  }

  return acc;
}, {});

const hasFieldResolvers = (type, filterFields) => {
  const fields = type.getFields();
  return Object.keys(filterFields).some(fieldName => {
    const filterValue = filterFields[fieldName];
    const field = fields[fieldName];
    return Boolean(field.resolve) || filterValue !== true && hasFieldResolvers(getNamedType(field.type), filterValue);
  });
};

module.exports = {
  dropQueryOperators,
  getQueryFields,
  hasFieldResolvers
};
//# sourceMappingURL=query.js.map