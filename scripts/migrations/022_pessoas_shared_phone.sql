-- A single phone can legitimately belong to more than one person (families,
-- couples and shared business contacts). Identity remains protected by the
-- unique pessoas.codigo key; phone is a matching signal, not an identifier.
DROP INDEX IF EXISTS pessoas_celular_normalizado_uniq;