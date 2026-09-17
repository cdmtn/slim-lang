import "./C:/Users/zeral/AppData/Local/Temp/claude/D--dev-slim-github/72243d74-23bd-4f88-a955-b7ed76b7e749/scratchpad/myapp/dist/external/core.js";
import * as crypto from "node:crypto";
import { SHA256, QuickHash } from "../types/hash.js";
let _slimType = {};
export const StringHelper = __typed_variable__({
  len(str) {
    let _slimType2 = {};
    __typed_parameter__(str, __type_spec__(__type_ref__("string")), _slimType2, "str", false, `function "len": argument<0> "str" expected string, got ${type(str)}`);
    if (type(str) == "string") return __typed_return__(str.length, __type_spec__(__type_ref__("int")), "len");
  },
  truncate(str, maxLength) {
    let _slimType3 = {},
      _slimType4 = {};
    __typed_parameter__(str, __type_spec__(__type_ref__("string")), _slimType3, "str", false, `function "truncate": argument<0> "str" expected string, got ${type(str)}`);
    __typed_parameter__(maxLength, __type_spec__(__type_ref__("int")), _slimType4, "maxLength", false, `function "truncate": argument<1> "maxLength" expected int, got ${type(maxLength)}`);
    if (str.length > maxLength) {
      return __typed_return__(str.slice(0, maxLength) + '...', __type_spec__(__type_ref__("string")), "truncate");
    }
    return __typed_return__(str, __type_spec__(__type_ref__("string")), "truncate");
  },
  hash(str) {
    let _slimType5 = {};
    __typed_parameter__(str, __type_spec__(__type_ref__("string")), _slimType5, "str", false, `function "hash": argument<0> "str" expected string, got ${type(str)}`);
    return __typed_return__(crypto.createHash("sha256").update(str).digest("hex"), __type_spec__(__type_ref__("SHA256", () => SHA256)), "hash");
  },
  quickHash(str) {
    let _slimType6 = {};
    __typed_parameter__(str, __type_spec__(__type_ref__("string")), _slimType6, "str", false, `function "quickHash": argument<0> "str" expected string, got ${type(str)}`);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return __typed_return__(hash, __type_spec__(__type_ref__("QuickHash", () => QuickHash)), "quickHash");
  }
}, __type_spec__(__type_ref__("object")), _slimType, "StringHelper");
export { StringHelper as default };
try {
  __lock_object__(StringHelper);
} catch (__err__) {
  __handle_sync_error__(__err__);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJtYXBwaW5ncyI6Ijs7OztBQUdBLGFBQUFBLFlBQUEsR0FBQUMsa0JBQUEsQ0FBNEM7RUFDNUNDLElBQUFDLEdBQUE7SUFBQSxJQUFBQyxVQUFBO0lBQUFDLG1CQUFBLENBQUFGLEdBQUEsRUFBQUcsYUFBQSxDQUFBQyxZQUFBLGFBQUFILFVBQUEsMEVBQUFJLElBQUEsQ0FBQUwsR0FBQTtJQUNBLElBQUFLLElBQUEsQ0FBQUwsR0FBQSxDQUFxQixxQkFBQU0sZ0JBQUEsQ0FBQU4sR0FBQSxDQUFBTyxNQUFBLEVBQUFKLGFBQUEsQ0FBQUMsWUFBQTtFQUNyQjtFQUNBSSxTQUFBUixHQUFBLEVBQUFTLFNBQUE7SUFBQSxJQUFBQyxVQUFBO01BQUFDLFVBQUE7SUFBQVQsbUJBQUEsQ0FBQUYsR0FBQSxFQUFBRyxhQUFBLENBQUFDLFlBQUEsYUFBQU0sVUFBQSwrRUFBQUwsSUFBQSxDQUFBTCxHQUFBO0lBQUFFLG1CQUFBLENBQUFPLFNBQUEsRUFBQU4sYUFBQSxDQUFBQyxZQUFBLFVBQUFPLFVBQUEsd0ZBQUFOLElBQUEsQ0FBQUksU0FBQTtJQUNBLElBQUFULEdBQUEsQ0FBQU8sTUFBQSxHQUFBRSxTQUFBO01BQ0EsT0FBQUgsZ0JBQUEsQ0FBQU4sR0FBQSxDQUFBWSxLQUFBLElBQUFILFNBQUEsV0FBQU4sYUFBQSxDQUFBQyxZQUFBO0lBQ0E7SUFDQSxPQUFBRSxnQkFBQSxDQUFBTixHQUFBLEVBQUFHLGFBQUEsQ0FBQUMsWUFBQTtFQUNBO0VBQ0FTLEtBQUFiLEdBQUE7SUFBQSxJQUFBYyxVQUFBO0lBQUFaLG1CQUFBLENBQUFGLEdBQUEsRUFBQUcsYUFBQSxDQUFBQyxZQUFBLGFBQUFVLFVBQUEsMkVBQUFULElBQUEsQ0FBQUwsR0FBQTtJQUNBLE9BQUFNLGdCQUFBLENBQUFTLE1BQUEsQ0FBQUMsVUFBQSxXQUFBQyxNQUFBLENBQUFqQixHQUFBLEVBQUFrQixNQUFBLFNBQUFmLGFBQUEsQ0FBQUMsWUFBQSxpQkFBQWUsTUFBQTtFQUNBO0VBQ0FDLFVBQUFwQixHQUFBO0lBQUEsSUFBQXFCLFVBQUE7SUFBQW5CLG1CQUFBLENBQUFGLEdBQUEsRUFBQUcsYUFBQSxDQUFBQyxZQUFBLGFBQUFpQixVQUFBLGdGQUFBaEIsSUFBQSxDQUFBTCxHQUFBO0lBQ0EsSUFBQWEsSUFBQTtJQUNBLFNBQUFTLENBQUEsTUFBQUEsQ0FBQSxHQUFBdEIsR0FBQSxDQUFBTyxNQUFBLEVBQUFlLENBQUE7TUFDQVQsSUFBQSxJQUFBQSxJQUFBLFNBQUFBLElBQUEsR0FBQWIsR0FBQSxDQUFBdUIsVUFBQSxDQUFBRCxDQUFBO01BQ0FULElBQUE7SUFDQTtJQUNBLE9BQUFQLGdCQUFBLENBQUFPLElBQUEsRUFBQVYsYUFBQSxDQUFBQyxZQUFBLG9CQUFBb0IsU0FBQTtFQUNBO0FBQ0EsQ0FyQkEsRUFBQXJCLGFBQUEsQ0FBQUMsWUFBQSxhQUFBcUIsU0FBQTtBQUFBLFNBQUE1QixZQUFBLElBQUE2QixPQUFBO0FBcUJFO0VBRUZDLGVBQUEsQ0FBQTlCLFlBQUEsQ0FBaUI7QUFBQSxTQUFBK0IsT0FBQTtFQUFBQyxxQkFBQSxDQUFBRCxPQUFBO0FBQUEiLCJuYW1lcyI6WyJTdHJpbmdIZWxwZXIiLCJfX3R5cGVkX3ZhcmlhYmxlX18iLCJsZW4iLCJzdHIiLCJfc2xpbVR5cGUyIiwiX190eXBlZF9wYXJhbWV0ZXJfXyIsIl9fdHlwZV9zcGVjX18iLCJfX3R5cGVfcmVmX18iLCJ0eXBlIiwiX190eXBlZF9yZXR1cm5fXyIsImxlbmd0aCIsInRydW5jYXRlIiwibWF4TGVuZ3RoIiwiX3NsaW1UeXBlMyIsIl9zbGltVHlwZTQiLCJzbGljZSIsImhhc2giLCJfc2xpbVR5cGU1IiwiY3J5cHRvIiwiY3JlYXRlSGFzaCIsInVwZGF0ZSIsImRpZ2VzdCIsIlNIQTI1NiIsInF1aWNrSGFzaCIsIl9zbGltVHlwZTYiLCJpIiwiY2hhckNvZGVBdCIsIlF1aWNrSGFzaCIsIl9zbGltVHlwZSIsImRlZmF1bHQiLCJfX2xvY2tfb2JqZWN0X18iLCJfX2Vycl9fIiwiX19oYW5kbGVfc3luY19lcnJvcl9fIl0sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbIkQ6XFxkZXZcXHNsaW0tZ2l0aHViXFxwYWNrYWdlc1xcc2xpbVxcaGVscGVyc1xcc3RyaW5nLnNsaW0iXSwic291cmNlc0NvbnRlbnQiOlsidXNlICogYXMgY3J5cHRvIGZyb20gXCJub2RlOmNyeXB0b1wiXHJcbnVzZSB7IFNIQTI1NiwgUXVpY2tIYXNoIH0gZnJvbSBAc2xpbS90eXBlcy9oYXNoXHJcblxyXG5leHBvcnQgZGVmYXVsdCBjb25zdCBTdHJpbmdIZWxwZXI6IG9iamVjdCA9IHtcclxuICAgIGxlbihzdHI6IHN0cmluZyk6IGludCB7XHJcbiAgICAgICAgaWYoa2luZG9mIHN0ciA9PSBcInN0cmluZ1wiKSByZXR1cm4gc3RyLmxlbmd0aFxyXG4gICAgfSxcclxuICAgIHRydW5jYXRlKHN0cjogc3RyaW5nLCBtYXhMZW5ndGg6IGludCk6IHN0cmluZyB7XHJcbiAgICAgICAgaWYgKHN0ci5sZW5ndGggPiBtYXhMZW5ndGgpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHN0ci5zbGljZSgwLCBtYXhMZW5ndGgpICsgJy4uLic7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBzdHI7XHJcbiAgICB9LFxyXG4gICAgaGFzaChzdHI6IHN0cmluZyk6IFNIQTI1NiB7XHJcbiAgICAgICAgcmV0dXJuIGNyeXB0by5jcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShzdHIpLmRpZ2VzdChcImhleFwiKVxyXG4gICAgfSxcclxuICAgIHF1aWNrSGFzaChzdHI6IHN0cmluZyk6IFF1aWNrSGFzaCB7XHJcbiAgICAgICAgbGV0IGhhc2ggPSAwO1xyXG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgc3RyLmxlbmd0aDsgaSsrKSB7XHJcbiAgICAgICAgICAgIGhhc2ggPSAoaGFzaCA8PCA1KSAtIGhhc2ggKyBzdHIuY2hhckNvZGVBdChpKTtcclxuICAgICAgICAgICAgaGFzaCB8PSAwO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gaGFzaDtcclxuICAgIH1cclxufVxyXG5cclxubG9jayBTdHJpbmdIZWxwZXI7Il19