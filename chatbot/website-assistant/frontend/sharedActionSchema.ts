import { z } from 'zod'
import definitions from './tool-schemas.json'

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean | Schema; items?: Schema; enum?: string[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number }
function convert(schema: Schema): z.ZodType {
  if (schema.enum) return z.enum(schema.enum as [string, ...string[]])
  if (schema.type === 'object') {
    if (!schema.properties) return z.record(z.string(), typeof schema.additionalProperties === 'object' ? convert(schema.additionalProperties) : z.unknown())
    const fields: Record<string, z.ZodType> = {}
    for (const [name, field] of Object.entries(schema.properties)) {
      fields[name] = schema.required?.includes(name) ? convert(field) : convert(field).optional()
    }
    return schema.additionalProperties === false ? z.object(fields).strict() : z.object(fields).passthrough()
  }
  if (schema.type === 'array') return z.array(convert(schema.items ?? {}))
  if (schema.type === 'boolean') return z.boolean()
  if (schema.type === 'integer' || schema.type === 'number') {
    let value = schema.type === 'integer' ? z.number().int() : z.number()
    if (schema.minimum !== undefined) value = value.min(schema.minimum)
    if (schema.maximum !== undefined) value = value.max(schema.maximum)
    return value
  }
  if (schema.type === 'string') {
    let value = z.string()
    if (schema.minLength !== undefined) value = value.min(schema.minLength)
    if (schema.maxLength !== undefined) value = value.max(schema.maxLength)
    return value
  }
  return z.unknown()
}
export function sharedActionParameters(name: string) {
  const tool = definitions.tools.find(item => item.function.name === name)
  if (!tool) throw new Error('Unknown shared action')
  return convert(tool.function.parameters as unknown as Schema) as z.ZodObject<Record<string, z.ZodType>>
}
