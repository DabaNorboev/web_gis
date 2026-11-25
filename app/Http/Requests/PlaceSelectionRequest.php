<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;

class PlaceSelectionRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function validationData(): array
    {
        $data = json_decode($this->getContent(), true, 32, JSON_THROW_ON_ERROR);
        if (array_diff(array_keys($data), ['lon', 'lat']) !== []) {
            throw new HttpResponseException(response()->json(['code' => 'INVALID_REQUEST',
                'message' => 'Некорректный запрос выбора точки.'], 422));
        }

        return $data;
    }

    public function rules(): array
    {
        $number = fn ($attribute, $value, $fail) => ((is_int($value) || is_float($value)) && is_finite((float) $value)) ?: $fail('Invalid number.');

        return [
            'lon' => ['required', $number, 'numeric', 'between:-180,180'],
            'lat' => ['required', $number, 'numeric', 'between:-90,90'],
        ];
    }
}
