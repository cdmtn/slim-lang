export default `S0002: required struct field is missing

Supply the field, or declare it optional with *field: Type. An optional
field may be omitted; if present, its value must still match the type.
A nullable Type? accepts null and undefined but does not make a field optional.
Struct.parse and Struct.new apply defaults; Struct.verify does not.`
