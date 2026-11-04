import { Type, type TUnsafe } from "typebox";

/** TypeBox-typed `{ type: "string", enum }`; pi-ai >=1.5 types its own StringEnum with pi-schema. */
export function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}
