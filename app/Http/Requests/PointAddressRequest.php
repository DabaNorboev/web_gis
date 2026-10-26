<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class PointAddressRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return ['lon' => ['required', 'numeric', 'between:-180,180'], 'lat' => ['required', 'numeric', 'between:-90,90']];
    }

    public function validationData(): array
    {
        // Coordinates are accepted only in the JSON body, never from a query string.
        return $this->json()->all();
    }
}
